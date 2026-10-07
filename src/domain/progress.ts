import { createHash } from "node:crypto";

export const POINTS_PER_COMPLETION = 10;

export interface CompletionResult {
  lessonId: string;
  status: "completed";
  score: number;
  version: number;
  pointsAwarded: number;
  completedAt: string;
}

export interface LessonProgress extends CompletionResult {
  learnerId: string;
}

export interface CompletionPlan {
  nextVersion: number;
  pointsAwarded: number;
  completedAt: string;
}

export interface CompletionFingerprintInput {
  learnerId: string;
  lessonId: string;
  score: number;
  expectedVersion: number;
}

export function planCompletion(expectedVersion: number, now: Date): CompletionPlan {
  return {
    nextVersion: expectedVersion + 1,
    pointsAwarded: POINTS_PER_COMPLETION,
    completedAt: now.toISOString(),
  };
}

export function completionFingerprint(input: CompletionFingerprintInput): string {
  const canonical = JSON.stringify({
    operation: "completeLesson",
    learnerId: input.learnerId,
    lessonId: input.lessonId,
    score: input.score,
    expectedVersion: input.expectedVersion,
  });
  return createHash("sha256").update(canonical).digest("hex");
}

export type ProgressConflict = "VERSION_CONFLICT" | "LESSON_ALREADY_COMPLETED";

export interface StoredProgressVersion {
  version: number;
  status: string;
}

export function classifyProgressWriteFailure(
  current: StoredProgressVersion | null,
  expectedVersion: number,
): ProgressConflict {
  if (!current || current.version !== expectedVersion) {
    return "VERSION_CONFLICT";
  }
  if (current.status === "completed") {
    return "LESSON_ALREADY_COMPLETED";
  }
  return "VERSION_CONFLICT";
}

export function sameCompletionFingerprint(stored: string, requested: string): boolean {
  return stored === requested;
}
