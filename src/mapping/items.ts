import { z } from "zod";
import type { CompletionResult, LessonProgress } from "../domain/progress.js";
import { learnerIndexSk, learnerPk, lessonIndexPk, lessonSk, requestSk } from "../persistence/keys.js";

export const completionResultSchema = z.strictObject({
  lessonId: z.string(),
  status: z.literal("completed"),
  score: z.number().int(),
  version: z.number().int(),
  pointsAwarded: z.number().int(),
  completedAt: z.string(),
});

const progressItemSchema = z.strictObject({
  pk: z.string(),
  sk: z.string(),
  entityType: z.literal("PROGRESS"),
  learnerId: z.string(),
  lessonId: z.string(),
  status: z.literal("completed"),
  score: z.number().int(),
  version: z.number().int(),
  pointsAwarded: z.number().int(),
  completedAt: z.string(),
  gsi1pk: z.string(),
  gsi1sk: z.string(),
});

const idempotencyItemSchema = z.strictObject({
  pk: z.string(),
  sk: z.string(),
  entityType: z.literal("IDEMPOTENCY"),
  fingerprint: z.string(),
  statusCode: z.number().int(),
  responseJson: z.string(),
  createdAt: z.string(),
});

const summaryItemSchema = z.strictObject({
  pk: z.string(),
  sk: z.string(),
  entityType: z.literal("SUMMARY"),
  learnerId: z.string(),
  totalPoints: z.number().int(),
  updatedAt: z.string(),
});

export interface IdempotencyRecord {
  fingerprint: string;
  statusCode: number;
  result: CompletionResult;
  createdAt: string;
}

export function toProgressItem(progress: LessonProgress): Record<string, string | number> {
  return {
    pk: learnerPk(progress.learnerId),
    sk: lessonSk(progress.lessonId),
    entityType: "PROGRESS",
    learnerId: progress.learnerId,
    lessonId: progress.lessonId,
    status: progress.status,
    score: progress.score,
    version: progress.version,
    pointsAwarded: progress.pointsAwarded,
    completedAt: progress.completedAt,
    gsi1pk: lessonIndexPk(progress.lessonId),
    gsi1sk: learnerIndexSk(progress.learnerId),
  };
}

export function toIdempotencyItem(input: {
  learnerId: string;
  idempotencyKey: string;
  fingerprint: string;
  statusCode: number;
  result: CompletionResult;
  createdAt: string;
}): Record<string, string | number> {
  return {
    pk: learnerPk(input.learnerId),
    sk: requestSk(input.idempotencyKey),
    entityType: "IDEMPOTENCY",
    fingerprint: input.fingerprint,
    statusCode: input.statusCode,
    responseJson: JSON.stringify(input.result),
    createdAt: input.createdAt,
  };
}

export function readProgressItem(item: unknown): LessonProgress | null {
  const parsed = progressItemSchema.safeParse(item);
  if (!parsed.success) {
    return null;
  }
  return {
    learnerId: parsed.data.learnerId,
    lessonId: parsed.data.lessonId,
    status: parsed.data.status,
    score: parsed.data.score,
    version: parsed.data.version,
    pointsAwarded: parsed.data.pointsAwarded,
    completedAt: parsed.data.completedAt,
  };
}

export function readIdempotencyItem(item: unknown): IdempotencyRecord | null {
  const parsed = idempotencyItemSchema.safeParse(item);
  if (!parsed.success) {
    return null;
  }
  let body: unknown;
  try {
    body = JSON.parse(parsed.data.responseJson);
  } catch {
    return null;
  }
  const result = completionResultSchema.safeParse(body);
  if (!result.success) {
    return null;
  }
  return {
    fingerprint: parsed.data.fingerprint,
    statusCode: parsed.data.statusCode,
    result: result.data,
    createdAt: parsed.data.createdAt,
  };
}

export function readSummaryPoints(item: unknown): number | null {
  const parsed = summaryItemSchema.safeParse(item);
  if (!parsed.success) {
    return null;
  }
  return parsed.data.totalPoints;
}
