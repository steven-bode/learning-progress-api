import { describe, expect, it } from "vitest";
import { decideCancellation } from "../../src/domain/cancellation.js";
import {
  POINTS_PER_COMPLETION,
  classifyProgressWriteFailure,
  completionFingerprint,
  planCompletion,
  sameCompletionFingerprint,
} from "../../src/domain/progress.js";

const input = {
  learnerId: "learner-1",
  lessonId: "intro",
  score: 80,
  expectedVersion: 0,
};

describe("completion rules", () => {
  it("awards ten points and moves a missing lesson from version 0 to 1", () => {
    const plan = planCompletion(0, new Date("2026-10-07T09:00:00.000Z"));
    expect(plan).toEqual({
      nextVersion: 1,
      pointsAwarded: POINTS_PER_COMPLETION,
      completedAt: "2026-10-07T09:00:00.000Z",
    });
    expect(POINTS_PER_COMPLETION).toBe(10);
  });

  it("keeps the fingerprint stable for the same operation and changes it with the payload", () => {
    const first = completionFingerprint(input);
    const second = completionFingerprint(input);
    const changed = completionFingerprint({ ...input, score: 81 });
    expect(first).toBe(second);
    expect(sameCompletionFingerprint(first, second)).toBe(true);
    expect(sameCompletionFingerprint(first, changed)).toBe(false);
  });

  it("distinguishes a stale version from an already completed lesson", () => {
    expect(classifyProgressWriteFailure(null, 0)).toBe("VERSION_CONFLICT");
    expect(classifyProgressWriteFailure({ version: 1, status: "completed" }, 0)).toBe("VERSION_CONFLICT");
    expect(classifyProgressWriteFailure({ version: 1, status: "completed" }, 1)).toBe(
      "LESSON_ALREADY_COMPLETED",
    );
  });
});

describe("transaction cancellation", () => {
  it("does not treat every cancellation as a duplicate", () => {
    expect(decideCancellation(["ConditionalCheckFailed", "None", "None"])).toBe("idempotency");
    expect(decideCancellation(["ConditionalCheckFailed", "ConditionalCheckFailed", "None"])).toBe("idempotency");
    expect(decideCancellation(["None", "ConditionalCheckFailed", "None"])).toBe("progress");
    expect(decideCancellation(["TransactionConflict", "TransactionConflict", "TransactionConflict"])).toBe("retry");
    expect(decideCancellation(["None", "None", "ThrottlingError"])).toBe("retry");
    expect(decideCancellation(["ValidationError", "None", "None"])).toBe("failure");
    expect(decideCancellation(["None", "None", "None"])).toBe("failure");
  });
});
