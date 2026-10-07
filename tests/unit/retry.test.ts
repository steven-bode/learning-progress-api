import { TransactionCanceledException } from "@aws-sdk/client-dynamodb";
import type { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { GetCommand, TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import { describe, expect, it } from "vitest";
import { completionFingerprint } from "../../src/domain/progress.js";
import { DomainError } from "../../src/domain/errors.js";
import {
  BACKOFF_CAP_MS,
  InvocationDeadline,
  MAX_COMPLETION_ATTEMPTS,
  RETRY_COMPLETION_MESSAGE,
  UNCERTAIN_COMPLETION_MESSAGE,
  backoffDelayMs,
} from "../../src/persistence/deadline.js";
import { toIdempotencyItem, toProgressItem } from "../../src/mapping/items.js";
import { lessonSk, requestSk } from "../../src/persistence/keys.js";
import {
  ProgressRepository,
  type CompleteLessonCommand,
  type RetryControls,
} from "../../src/persistence/repository.js";

const command: CompleteLessonCommand = {
  learnerId: "learner-1",
  lessonId: "intro",
  score: 80,
  expectedVersion: 0,
  idempotencyKey: "key-1",
  now: new Date("2026-10-07T09:00:00.000Z"),
};

const noWait: RetryControls = {
  random: () => 0,
  sleep: () => Promise.resolve(),
};

function deadline(remaining: () => number): InvocationDeadline {
  return new InvocationDeadline(remaining, 250, () => () => undefined);
}

function repository(
  handle: (name: string, sentCommand: object) => Promise<unknown>,
  timing: RetryControls = noWait,
): { repo: ProgressRepository; sent: string[] } {
  const sent: string[] = [];
  const client = {
    async send(commandToSend: object) {
      sent.push(commandToSend.constructor.name);
      return handle(commandToSend.constructor.name, commandToSend);
    },
  };
  return {
    sent,
    repo: new ProgressRepository(client as DynamoDBDocumentClient, "learning-progress-test", timing),
  };
}

function canceled(codes: string[]): TransactionCanceledException {
  return new TransactionCanceledException({
    message: "Transaction cancelled",
    $metadata: {},
    CancellationReasons: codes.map((code) => ({ Code: code })),
  });
}

describe("retry budget", () => {
  it("bounds exponential backoff with jitter", () => {
    expect(backoffDelayMs(0, () => 0)).toBe(0);
    expect(backoffDelayMs(0, () => 0.5)).toBe(10);
    expect(backoffDelayMs(4, () => 1)).toBe(BACKOFF_CAP_MS);
  });

  it("does not call DynamoDB when the response budget is already gone", async () => {
    const { repo, sent } = repository(async () => {
      throw new Error("should not be called");
    });
    await expect(repo.completeLesson(command, deadline(() => 100))).rejects.toMatchObject({
      code: "TEMPORARILY_UNAVAILABLE",
      message: RETRY_COMPLETION_MESSAGE,
    });
    expect(sent).toEqual([]);
    expect(RETRY_COMPLETION_MESSAGE).not.toMatch(/rolled back/i);
  });

  it("does not retry a progress conflict", async () => {
    const { repo, sent } = repository(async (name) => {
      if (name === TransactWriteCommand.name) {
        throw canceled(["None", "ConditionalCheckFailed", "None"]);
      }
      if (name === GetCommand.name) {
        return {
          Item: toProgressItem({
            learnerId: command.learnerId,
            lessonId: command.lessonId,
            status: "completed",
            score: 80,
            version: 1,
            pointsAwarded: 10,
            completedAt: "2026-10-07T09:00:00.000Z",
          }),
        };
      }
      throw new Error(`unexpected ${name}`);
    });

    await expect(repo.completeLesson(command, deadline(() => 5_000))).rejects.toMatchObject({
      code: "VERSION_CONFLICT",
      currentVersion: 1,
    });
    expect(sent.filter((name) => name === TransactWriteCommand.name)).toHaveLength(1);
  });

  it("stops after the retry limit and does not treat every conflict as a duplicate", async () => {
    const { repo, sent } = repository(async (name) => {
      if (name === TransactWriteCommand.name) {
        throw canceled(["TransactionConflict", "TransactionConflict", "TransactionConflict"]);
      }
      return {};
    });

    await expect(repo.completeLesson(command, deadline(() => 5_000))).rejects.toBeInstanceOf(DomainError);
    expect(sent.filter((name) => name === TransactWriteCommand.name)).toHaveLength(MAX_COMPLETION_ATTEMPTS);
    expect(sent.filter((name) => name === GetCommand.name).length).toBeGreaterThan(0);
  });

  it("returns the stored result after an uncertain write when time remains", async () => {
    const fingerprint = completionFingerprint(command);
    const result = {
      lessonId: command.lessonId,
      status: "completed" as const,
      score: command.score,
      version: 1,
      pointsAwarded: 10,
      completedAt: "2026-10-07T09:00:00.000Z",
    };
    const { repo, sent } = repository(async (name) => {
      if (name === TransactWriteCommand.name) {
        throw Object.assign(new Error("Request aborted"), { name: "AbortError" });
      }
      return {
        Item: toIdempotencyItem({
          learnerId: command.learnerId,
          idempotencyKey: command.idempotencyKey,
          fingerprint,
          statusCode: 201,
          result,
          createdAt: result.completedAt,
        }),
      };
    });

    const outcome = await repo.completeLesson(command, deadline(() => 5_000));
    expect(outcome.replayed).toBe(true);
    expect(outcome.result).toEqual(result);
    expect(sent.map((name) => name)).toEqual([TransactWriteCommand.name, GetCommand.name]);
  });

  it("does not read after an uncertain write when no response budget remains", async () => {
    let remaining = 5_000;
    const { repo, sent } = repository(async () => {
      remaining = 0;
      throw Object.assign(new Error("socket timed out"), { name: "TimeoutError" });
    });

    await expect(repo.completeLesson(command, deadline(() => remaining))).rejects.toMatchObject({
      message: UNCERTAIN_COMPLETION_MESSAGE,
    });
    expect(sent).toEqual([TransactWriteCommand.name]);
  });

  it("classifies an already completed lesson without a progress update", async () => {
    let reads = 0;
    const { repo, sent } = repository(async (name) => {
      if (name !== GetCommand.name) {
        throw new Error(`unexpected ${name}`);
      }
      reads += 1;
      if (reads === 1) {
        return {};
      }
      return {
        Item: toProgressItem({
          learnerId: command.learnerId,
          lessonId: command.lessonId,
          status: "completed",
          score: 80,
          version: 1,
          pointsAwarded: 10,
          completedAt: "2026-10-07T09:00:00.000Z",
        }),
      };
    });

    await expect(
      repo.completeLesson({ ...command, expectedVersion: 1, idempotencyKey: "other-key" }, deadline(() => 5_000)),
    ).rejects.toMatchObject({ code: "LESSON_ALREADY_COMPLETED" });
    expect(sent).toEqual([GetCommand.name, GetCommand.name]);
  });

  it("replays a concurrent commit of the same key after retryable cancellations", async () => {
    const fingerprint = completionFingerprint(command);
    const { repo, sent } = repository(async (name, sentCommand) => {
      if (name === TransactWriteCommand.name) {
        throw retryableCancellation();
      }
      expect(sortKey(sentCommand)).toBe(requestSk(command.idempotencyKey));
      return { Item: marker(fingerprint) };
    });

    const outcome = await repo.completeLesson(command, deadline(() => 5_000));
    expect(outcome).toEqual({ statusCode: 201, replayed: true, result: storedResult });
    expect(sent.filter((name) => name === TransactWriteCommand.name)).toHaveLength(MAX_COMPLETION_ATTEMPTS);
    expect(sent.filter((name) => name === GetCommand.name)).toEqual([GetCommand.name]);
  });

  it("returns IDEMPOTENCY_CONFLICT when the stored marker has another fingerprint", async () => {
    const { repo, sent } = repository(async (name, sentCommand) => {
      if (name === TransactWriteCommand.name) {
        throw retryableCancellation();
      }
      expect(sortKey(sentCommand)).toBe(requestSk(command.idempotencyKey));
      return { Item: marker(completionFingerprint({ ...command, score: 0 })) };
    });

    await expect(repo.completeLesson(command, deadline(() => 5_000))).rejects.toMatchObject({
      code: "IDEMPOTENCY_CONFLICT",
    });
    expect(sent.filter((name) => name === GetCommand.name)).toEqual([GetCommand.name]);
  });

  it("replays a marker that appears between the marker read and the progress read", async () => {
    const fingerprint = completionFingerprint(command);
    let markerReads = 0;
    const { repo, sent } = repository(async (name, sentCommand) => {
      if (name === TransactWriteCommand.name) {
        throw retryableCancellation();
      }
      const sk = sortKey(sentCommand);
      if (sk === requestSk(command.idempotencyKey)) {
        markerReads += 1;
        return markerReads === 1 ? {} : { Item: marker(fingerprint) };
      }
      expect(sk).toBe(lessonSk(command.lessonId));
      return { Item: completedProgress() };
    });

    const outcome = await repo.completeLesson(command, deadline(() => 5_000));
    expect(outcome).toEqual({ statusCode: 201, replayed: true, result: storedResult });
    expect(sent.filter((name) => name === GetCommand.name)).toHaveLength(3);
  });

  it("returns a progress conflict when a different key completed the lesson", async () => {
    const { repo, sent } = repository(async (name, sentCommand) => {
      if (name === TransactWriteCommand.name) {
        throw retryableCancellation();
      }
      const sk = sortKey(sentCommand);
      if (sk === requestSk(command.idempotencyKey)) {
        return {};
      }
      expect(sk).toBe(lessonSk(command.lessonId));
      return { Item: completedProgress() };
    });

    await expect(repo.completeLesson(command, deadline(() => 5_000))).rejects.toMatchObject({
      code: "VERSION_CONFLICT",
      currentVersion: 1,
    });
    expect(sent.filter((name) => name === GetCommand.name)).toHaveLength(3);
  });

  it("does not start classification reads when the budget is gone after retries", async () => {
    let remaining = 5_000;
    let writes = 0;
    const { repo, sent } = repository(async (name) => {
      expect(name).toBe(TransactWriteCommand.name);
      writes += 1;
      if (writes === MAX_COMPLETION_ATTEMPTS) {
        remaining = 0;
      }
      throw retryableCancellation();
    });

    await expect(repo.completeLesson(command, deadline(() => remaining))).rejects.toMatchObject({
      code: "TEMPORARILY_UNAVAILABLE",
      message: RETRY_COMPLETION_MESSAGE,
    });
    expect(sent).toEqual(Array.from({ length: MAX_COMPLETION_ATTEMPTS }, () => TransactWriteCommand.name));
    expect(RETRY_COMPLETION_MESSAGE).not.toMatch(/rolled back/i);
  });
});

const storedResult = {
  lessonId: command.lessonId,
  status: "completed" as const,
  score: command.score,
  version: 1,
  pointsAwarded: 10,
  completedAt: "2026-10-07T09:00:00.000Z",
};

function retryableCancellation(): TransactionCanceledException {
  return canceled(["TransactionConflict", "TransactionConflict", "TransactionConflict"]);
}

function sortKey(sentCommand: object): string {
  const input = (sentCommand as { input?: { Key?: { sk?: string } } }).input;
  return input?.Key?.sk ?? "";
}

function marker(fingerprint: string): Record<string, string | number> {
  return toIdempotencyItem({
    learnerId: command.learnerId,
    idempotencyKey: command.idempotencyKey,
    fingerprint,
    statusCode: 201,
    result: storedResult,
    createdAt: storedResult.completedAt,
  });
}

function completedProgress(): Record<string, string | number> {
  return toProgressItem({
    learnerId: command.learnerId,
    lessonId: command.lessonId,
    status: "completed",
    score: command.score,
    version: 1,
    pointsAwarded: 10,
    completedAt: storedResult.completedAt,
  });
}
