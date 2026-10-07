import { describe, expect, it } from "vitest";
import { readIdempotencyItem, readProgressItem, toIdempotencyItem, toProgressItem } from "../../src/mapping/items.js";
import type { LessonProgress } from "../../src/domain/progress.js";

const progress: LessonProgress = {
  learnerId: "learner-1",
  lessonId: "intro",
  status: "completed",
  score: 80,
  version: 1,
  pointsAwarded: 10,
  completedAt: "2026-10-07T09:00:00.000Z",
};

describe("item mappings", () => {
  it("maps a completed lesson onto the table key and the sparse index key", () => {
    const item = toProgressItem(progress);
    expect(item.pk).toBe("LEARNER#learner-1");
    expect(item.sk).toBe("LESSON#intro");
    expect(item.version).toBe(1);
    expect(item.gsi1pk).toBe("LESSON#intro");
    expect(item.gsi1sk).toBe("LEARNER#learner-1");
    expect(readProgressItem(item)).toEqual(progress);
  });

  it("stores the completion response on the idempotency item and reads it back", () => {
    const item = toIdempotencyItem({
      learnerId: "learner-1",
      idempotencyKey: "key-1",
      fingerprint: "abc",
      statusCode: 201,
      result: {
        lessonId: progress.lessonId,
        status: progress.status,
        score: progress.score,
        version: progress.version,
        pointsAwarded: progress.pointsAwarded,
        completedAt: progress.completedAt,
      },
      createdAt: progress.completedAt,
    });
    expect(item.sk).toBe("REQUEST#key-1");
    expect(item.gsi1pk).toBeUndefined();
    expect(readIdempotencyItem(item)?.statusCode).toBe(201);
    expect(readIdempotencyItem(item)?.fingerprint).toBe("abc");
  });

  it("rejects a progress item that is missing its version", () => {
    const item = toProgressItem(progress);
    delete item.version;
    expect(readProgressItem(item)).toBeNull();
  });
});
