import type { AttributeValue, CancellationReason } from "@aws-sdk/client-dynamodb";
import { TransactionCanceledException } from "@aws-sdk/client-dynamodb";
import type { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { GetCommand, QueryCommand, TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import { unmarshall } from "@aws-sdk/util-dynamodb";
import { decideCancellation } from "../domain/cancellation.js";
import { DomainError } from "../domain/errors.js";
import {
  classifyProgressWriteFailure,
  completionFingerprint,
  planCompletion,
  sameCompletionFingerprint,
  type CompletionResult,
  type LessonProgress,
} from "../domain/progress.js";
import {
  readIdempotencyItem,
  readProgressItem,
  readSummaryPoints,
  toIdempotencyItem,
  toProgressItem,
  type IdempotencyRecord,
} from "../mapping/items.js";
import {
  MAX_COMPLETION_ATTEMPTS,
  RETRY_COMPLETION_MESSAGE,
  RETRY_READ_MESSAGE,
  UNCERTAIN_COMPLETION_MESSAGE,
  backoffDelayMs,
  isUncertainOutcome,
  type InvocationDeadline,
} from "./deadline.js";
import { StorageError } from "./errors.js";
import {
  COMPLETIONS_INDEX,
  LESSON_PREFIX,
  SUMMARY_SK,
  learnerPk,
  lessonIndexPk,
  lessonSk,
  requestSk,
} from "./keys.js";

export interface RetryControls {
  random: () => number;
  sleep: (ms: number, signal: AbortSignal) => Promise<void>;
}

const defaultRetryControls: RetryControls = {
  random: () => Math.random(),
  sleep: (ms, signal) =>
    new Promise((resolve, reject) => {
      if (signal.aborted) {
        reject(abortError());
        return;
      }
      const timer = setTimeout(() => {
        signal.removeEventListener("abort", onAbort);
        resolve();
      }, ms);
      const onAbort = () => {
        clearTimeout(timer);
        reject(abortError());
      };
      signal.addEventListener("abort", onAbort, { once: true });
    }),
};

export interface CompleteLessonCommand {
  learnerId: string;
  lessonId: string;
  score: number;
  expectedVersion: number;
  idempotencyKey: string;
  now: Date;
}

export interface CompleteLessonOutcome {
  statusCode: number;
  replayed: boolean;
  result: CompletionResult;
}

export interface ProgressPage {
  totalPoints: number;
  items: LessonProgress[];
  lastEvaluatedKey: { pk: string; sk: string } | null;
}

type DynamoResponse = {
  Item?: Record<string, unknown>;
  Items?: Record<string, unknown>[];
  LastEvaluatedKey?: Record<string, unknown>;
};

export class ProgressRepository {
  constructor(
    private readonly client: DynamoDBDocumentClient,
    private readonly tableName: string,
    private readonly timing: RetryControls = defaultRetryControls,
  ) {}

  async getLessonProgress(
    learnerId: string,
    lessonId: string,
    deadline: InvocationDeadline,
  ): Promise<LessonProgress | null> {
    const item = await this.getItem(learnerPk(learnerId), lessonSk(lessonId), deadline);
    if (!item) {
      return null;
    }
    const progress = readProgressItem(item);
    if (!progress) {
      throw new StorageError("corrupt_progress_item");
    }
    return progress;
  }

  async listProgress(
    learnerId: string,
    limit: number,
    exclusiveStartKey: { pk: string; sk: string } | null,
    deadline: InvocationDeadline,
  ): Promise<ProgressPage> {
    this.requireBudget(deadline);
    let response: DynamoResponse;
    try {
      response = await this.send(
        new QueryCommand({
          TableName: this.tableName,
          KeyConditionExpression: "pk = :pk AND begins_with(sk, :lessonPrefix)",
          ExpressionAttributeValues: {
            ":pk": learnerPk(learnerId),
            ":lessonPrefix": LESSON_PREFIX,
          },
          Limit: limit,
          ConsistentRead: true,
          ScanIndexForward: true,
          ...(exclusiveStartKey ? { ExclusiveStartKey: exclusiveStartKey } : {}),
        }),
        deadline,
      );
    } catch (error) {
      throw this.readError(error);
    }

    const items: LessonProgress[] = [];
    for (const item of response.Items ?? []) {
      const progress = readProgressItem(item);
      if (!progress) {
        throw new StorageError("corrupt_progress_item");
      }
      items.push(progress);
    }

    return {
      totalPoints: await this.getTotalPoints(learnerId, deadline),
      items,
      lastEvaluatedKey: readPageKey(response.LastEvaluatedKey),
    };
  }

  async getTotalPoints(learnerId: string, deadline: InvocationDeadline): Promise<number> {
    const item = await this.getItem(learnerPk(learnerId), SUMMARY_SK, deadline);
    if (!item) {
      return 0;
    }
    const points = readSummaryPoints(item);
    if (points === null) {
      throw new StorageError("corrupt_summary_item");
    }
    return points;
  }

  async listCompletionsForLesson(
    lessonId: string,
    deadline: InvocationDeadline,
    limit = 50,
  ): Promise<LessonProgress[]> {
    const items: LessonProgress[] = [];
    let startKey: Record<string, unknown> | undefined;
    const maxPages = 10;

    for (let page = 0; page < maxPages && items.length < limit; page += 1) {
      this.requireBudget(deadline);
      let response: DynamoResponse;
      try {
        response = await this.send(
          new QueryCommand({
            TableName: this.tableName,
            IndexName: COMPLETIONS_INDEX,
            KeyConditionExpression: "gsi1pk = :pk",
            ExpressionAttributeValues: {
              ":pk": lessonIndexPk(lessonId),
            },
            // A GSI query cannot be strongly consistent. The index can lag behind the successful write.
            Limit: Math.min(25, limit - items.length),
            ...(startKey ? { ExclusiveStartKey: startKey } : {}),
          }),
          deadline,
        );
      } catch (error) {
        throw this.readError(error);
      }

      for (const item of response.Items ?? []) {
        const progress = readProgressItem(item);
        if (!progress) {
          throw new StorageError("corrupt_progress_item");
        }
        items.push(progress);
      }

      if (!response.LastEvaluatedKey) {
        break;
      }
      startKey = response.LastEvaluatedKey;
    }

    return items;
  }

  async completeLesson(
    command: CompleteLessonCommand,
    deadline: InvocationDeadline,
  ): Promise<CompleteLessonOutcome> {
    const fingerprint = completionFingerprint(command);
    if (command.expectedVersion !== 0) {
      // Every stored lesson is already completed, so a later version cannot be updated.
      return this.resolveWithoutWrite(command, fingerprint, deadline);
    }

    const plan = planCompletion(command.expectedVersion, command.now);
    const result: CompletionResult = {
      lessonId: command.lessonId,
      status: "completed",
      score: command.score,
      version: plan.nextVersion,
      pointsAwarded: plan.pointsAwarded,
      completedAt: plan.completedAt,
    };
    const progress: LessonProgress = {
      learnerId: command.learnerId,
      ...result,
    };
    const transactItems = [
      {
        Put: {
          TableName: this.tableName,
          Item: toIdempotencyItem({
            learnerId: command.learnerId,
            idempotencyKey: command.idempotencyKey,
            fingerprint,
            statusCode: 201,
            result,
            createdAt: plan.completedAt,
          }),
          ConditionExpression: "attribute_not_exists(pk)",
          ReturnValuesOnConditionCheckFailure: "ALL_OLD" as const,
        },
      },
      {
        Put: {
          TableName: this.tableName,
          Item: toProgressItem(progress),
          // A missing progress item is logical version 0.
          ConditionExpression: "attribute_not_exists(pk)",
          ReturnValuesOnConditionCheckFailure: "ALL_OLD" as const,
        },
      },
      {
        Update: {
          TableName: this.tableName,
          Key: {
            pk: learnerPk(command.learnerId),
            sk: SUMMARY_SK,
          },
          // Keep the marker and points update in the same transaction.
          UpdateExpression:
            "ADD totalPoints :points SET updatedAt = :now, learnerId = :learnerId, entityType = :entityType",
          ExpressionAttributeValues: {
            ":points": plan.pointsAwarded,
            ":now": plan.completedAt,
            ":learnerId": command.learnerId,
            ":entityType": "SUMMARY",
          },
        },
      },
    ];

    for (let attempt = 0; attempt < MAX_COMPLETION_ATTEMPTS; attempt += 1) {
      if (!deadline.hasBudget()) {
        return this.resolveCanceled(command, fingerprint, deadline);
      }
      try {
        // Do not rely on ClientRequestToken. Its idempotency window is only ten minutes.
        await this.send(new TransactWriteCommand({ TransactItems: transactItems }), deadline);
        return { statusCode: 201, replayed: false, result };
      } catch (error) {
        if (error instanceof DomainError) {
          throw error;
        }
        if (isUncertainOutcome(error)) {
          // A lost response does not prove the transaction was rolled back.
          return this.recoverUncertain(command, fingerprint, deadline);
        }
        const reasons = cancellationReasons(error);
        if (!reasons) {
          if (isTransactionInProgress(error) && (await this.pauseBeforeRetry(attempt, deadline))) {
            continue;
          }
          if (isTransactionInProgress(error)) {
            return this.recoverUncertain(command, fingerprint, deadline);
          }
          throw new StorageError("completion_failed", { cause: error });
        }

        const decision = decideCancellation(reasons.map((reason) => reason.Code ?? "Unknown"));
        if (decision === "idempotency") {
          return this.resolveIdempotency(command, fingerprint, reasons[0], deadline);
        }
        if (decision === "progress") {
          await this.rejectProgressConflict(command, reasons[1], deadline);
        }
        if (decision === "retry" && (await this.pauseBeforeRetry(attempt, deadline))) {
          continue;
        }
        if (decision === "retry") {
          return this.resolveCanceled(command, fingerprint, deadline);
        }
        throw new StorageError("completion_cancelled", {
          cause: error,
          cancellationCodes: reasons.map((reason) => reason.Code ?? "Unknown"),
        });
      }
    }

    return this.resolveCanceled(command, fingerprint, deadline);
  }

  private async resolveWithoutWrite(
    command: CompleteLessonCommand,
    fingerprint: string,
    deadline: InvocationDeadline,
  ): Promise<CompleteLessonOutcome> {
    this.requireBudget(deadline);
    const record = await this.readIdempotency(command.learnerId, command.idempotencyKey, deadline);
    if (record) {
      return this.outcomeFromRecord(record, fingerprint);
    }
    this.requireBudget(deadline);
    return this.rejectProgressConflict(command, undefined, deadline);
  }

  private async recoverUncertain(
    command: CompleteLessonCommand,
    fingerprint: string,
    deadline: InvocationDeadline,
  ): Promise<CompleteLessonOutcome> {
    if (!deadline.hasBudget()) {
      throw new DomainError("TEMPORARILY_UNAVAILABLE", UNCERTAIN_COMPLETION_MESSAGE);
    }
    try {
      const record = await this.readIdempotency(command.learnerId, command.idempotencyKey, deadline);
      if (!record) {
        throw new DomainError("TEMPORARILY_UNAVAILABLE", UNCERTAIN_COMPLETION_MESSAGE);
      }
      return this.outcomeFromRecord(record, fingerprint);
    } catch (error) {
      if (error instanceof DomainError) {
        throw error;
      }
      if (isUncertainOutcome(error)) {
        throw new DomainError("TEMPORARILY_UNAVAILABLE", UNCERTAIN_COMPLETION_MESSAGE);
      }
      throw error;
    }
  }

  private async resolveCanceled(
    command: CompleteLessonCommand,
    fingerprint: string,
    deadline: InvocationDeadline,
  ): Promise<CompleteLessonOutcome> {
    const record = await this.readCanceledIdempotency(command, deadline);
    if (record) {
      return this.outcomeFromRecord(record, fingerprint);
    }
    if (!deadline.hasBudget()) {
      throw new DomainError("TEMPORARILY_UNAVAILABLE", RETRY_COMPLETION_MESSAGE);
    }
    let progress: LessonProgress | null;
    try {
      progress = await this.getLessonProgress(command.learnerId, command.lessonId, deadline);
    } catch (error) {
      if (error instanceof DomainError && error.code === "TEMPORARILY_UNAVAILABLE") {
        throw new DomainError("TEMPORARILY_UNAVAILABLE", RETRY_COMPLETION_MESSAGE);
      }
      throw error;
    }
    if (!progress) {
      throw new DomainError("TEMPORARILY_UNAVAILABLE", RETRY_COMPLETION_MESSAGE);
    }
    // The same key can commit after the first marker read and before this conflict.
    const raced = await this.readCanceledIdempotency(command, deadline);
    if (raced) {
      return this.outcomeFromRecord(raced, fingerprint);
    }
    this.throwProgressConflict(progress, command.expectedVersion);
  }

  private async readCanceledIdempotency(
    command: CompleteLessonCommand,
    deadline: InvocationDeadline,
  ): Promise<IdempotencyRecord | null> {
    if (!deadline.hasBudget()) {
      throw new DomainError("TEMPORARILY_UNAVAILABLE", RETRY_COMPLETION_MESSAGE);
    }
    try {
      return await this.readIdempotency(command.learnerId, command.idempotencyKey, deadline);
    } catch (error) {
      if (error instanceof DomainError && error.code === "TEMPORARILY_UNAVAILABLE") {
        throw new DomainError("TEMPORARILY_UNAVAILABLE", RETRY_COMPLETION_MESSAGE);
      }
      throw error;
    }
  }

  private async pauseBeforeRetry(attempt: number, deadline: InvocationDeadline): Promise<boolean> {
    if (attempt >= MAX_COMPLETION_ATTEMPTS - 1) {
      return false;
    }
    const delayMs = backoffDelayMs(attempt, this.timing.random);
    if (deadline.budgetMs() <= delayMs) {
      return false;
    }
    try {
      await this.timing.sleep(delayMs, deadline.signal);
    } catch (error) {
      if (isUncertainOutcome(error)) {
        return false;
      }
      throw error;
    }
    return deadline.hasBudget();
  }

  private outcomeFromRecord(record: IdempotencyRecord, fingerprint: string): CompleteLessonOutcome {
    if (!sameCompletionFingerprint(record.fingerprint, fingerprint)) {
      throw new DomainError(
        "IDEMPOTENCY_CONFLICT",
        "This Idempotency-Key was already used for a different completion request.",
      );
    }
    return {
      statusCode: record.statusCode,
      replayed: true,
      result: record.result,
    };
  }

  private async resolveIdempotency(
    command: CompleteLessonCommand,
    fingerprint: string,
    reason: CancellationReason | undefined,
    deadline: InvocationDeadline,
  ): Promise<CompleteLessonOutcome> {
    const inline = reason ? readIdempotencyItem(itemFromReason(reason)) : null;
    if (inline) {
      return this.outcomeFromRecord(inline, fingerprint);
    }
    this.requireBudget(deadline);
    const record = await this.readIdempotency(command.learnerId, command.idempotencyKey, deadline);
    if (!record) {
      throw new StorageError("missing_idempotency_record");
    }
    return this.outcomeFromRecord(record, fingerprint);
  }

  private async rejectProgressConflict(
    command: CompleteLessonCommand,
    reason: CancellationReason | undefined,
    deadline: InvocationDeadline,
  ): Promise<never> {
    const inline = reason ? readProgressItem(itemFromReason(reason)) : null;
    const current = inline ?? (await this.getLessonProgress(command.learnerId, command.lessonId, deadline));
    this.throwProgressConflict(current, command.expectedVersion);
  }

  private throwProgressConflict(current: LessonProgress | null, expectedVersion: number): never {
    const code = classifyProgressWriteFailure(
      current ? { version: current.version, status: current.status } : null,
      expectedVersion,
    );
    if (code === "LESSON_ALREADY_COMPLETED") {
      throw new DomainError(
        "LESSON_ALREADY_COMPLETED",
        "This lesson is already completed. No additional points were awarded.",
      );
    }
    throw new DomainError("VERSION_CONFLICT", "The progress version does not match the expected version.", {
      currentVersion: current?.version ?? 0,
    });
  }

  private async readIdempotency(
    learnerId: string,
    idempotencyKey: string,
    deadline: InvocationDeadline,
  ): Promise<IdempotencyRecord | null> {
    const item = await this.getItem(learnerPk(learnerId), requestSk(idempotencyKey), deadline);
    if (!item) {
      return null;
    }
    const record = readIdempotencyItem(item);
    if (!record) {
      throw new StorageError("corrupt_idempotency_item");
    }
    return record;
  }

  private async getItem(pk: string, sk: string, deadline: InvocationDeadline): Promise<Record<string, unknown> | null> {
    this.requireBudget(deadline);
    try {
      const response = await this.send(
        new GetCommand({
          TableName: this.tableName,
          Key: { pk, sk },
          ConsistentRead: true,
        }),
        deadline,
      );
      return response.Item ?? null;
    } catch (error) {
      throw this.readError(error);
    }
  }

  private async send(command: object, deadline: InvocationDeadline): Promise<DynamoResponse> {
    this.requireBudget(deadline);
    return (await this.client.send(command as never, {
      abortSignal: deadline.signal,
    })) as DynamoResponse;
  }

  private requireBudget(deadline: InvocationDeadline): void {
    if (!deadline.hasBudget()) {
      throw new DomainError("TEMPORARILY_UNAVAILABLE", RETRY_READ_MESSAGE);
    }
  }

  private readError(error: unknown): Error {
    if (error instanceof DomainError) {
      return error;
    }
    if (isUncertainOutcome(error)) {
      return new DomainError("TEMPORARILY_UNAVAILABLE", RETRY_READ_MESSAGE);
    }
    return new StorageError("read_failed", { cause: error });
  }
}

function readPageKey(key: Record<string, unknown> | undefined): { pk: string; sk: string } | null {
  if (!key) {
    return null;
  }
  if (typeof key.pk !== "string" || typeof key.sk !== "string") {
    throw new StorageError("invalid_page_key");
  }
  return { pk: key.pk, sk: key.sk };
}

function cancellationReasons(error: unknown): CancellationReason[] | null {
  if (error instanceof TransactionCanceledException) {
    return error.CancellationReasons ?? [];
  }
  if (!(error instanceof Error) || error.name !== "TransactionCanceledException") {
    return null;
  }
  const candidate = error as Error & { CancellationReasons?: CancellationReason[] };
  return candidate.CancellationReasons ?? [];
}

function isTransactionInProgress(error: unknown): boolean {
  return error instanceof Error && error.name === "TransactionInProgressException";
}

function itemFromReason(reason: CancellationReason): unknown {
  if (!reason.Item) {
    return null;
  }
  const values = Object.values(reason.Item);
  const marshalled = values.some(
    (value) => value !== null && typeof value === "object" && ("S" in value || "N" in value || "BOOL" in value),
  );
  if (marshalled) {
    return unmarshall(reason.Item as Record<string, AttributeValue>);
  }
  return reason.Item;
}

function abortError(): Error {
  return Object.assign(new Error("Request aborted"), { name: "AbortError" });
}
