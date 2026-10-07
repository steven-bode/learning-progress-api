import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createDocumentClient } from "../../src/persistence/client.js";
import { InvocationDeadline } from "../../src/persistence/deadline.js";
import { ProgressRepository, type CompleteLessonCommand } from "../../src/persistence/repository.js";
import { TEST_ENDPOINT, TEST_REGION, TEST_TABLE } from "../constants.js";

const fixedNow = new Date("2026-10-07T09:00:00.000Z");

function repository() {
  const repo = new ProgressRepository(
    createDocumentClient({
      tableName: TEST_TABLE,
      region: TEST_REGION,
      authMode: "local",
      dynamoEndpoint: TEST_ENDPOINT,
    }),
    TEST_TABLE,
  );
  const deadline = new InvocationDeadline(() => 20_000, 0, () => () => undefined);
  return {
    getLessonProgress: (learnerId: string, lessonId: string) => repo.getLessonProgress(learnerId, lessonId, deadline),
    listProgress: (
      learnerId: string,
      limit: number,
      exclusiveStartKey: { pk: string; sk: string } | null,
    ) => repo.listProgress(learnerId, limit, exclusiveStartKey, deadline),
    getTotalPoints: (learnerId: string) => repo.getTotalPoints(learnerId, deadline),
    listCompletionsForLesson: (lessonId: string) => repo.listCompletionsForLesson(lessonId, deadline),
    completeLesson: (command: CompleteLessonCommand) => repo.completeLesson(command, deadline),
  };
}

function ids(prefix: string): { learnerId: string; lessonId: string; idempotencyKey: string } {
  const suffix = randomUUID().replaceAll("-", "").slice(0, 12);
  return {
    learnerId: `${prefix}${suffix}`,
    lessonId: `lesson-${suffix}`,
    idempotencyKey: `key-${suffix}`,
  };
}

describe("progress repository", () => {
  it("reads a missing lesson as no item and stores version 1 after completion", async () => {
    const repo = repository();
    const { learnerId, lessonId, idempotencyKey } = ids("read");
    expect(await repo.getLessonProgress(learnerId, lessonId)).toBeNull();

    const outcome = await repo.completeLesson({
      learnerId,
      lessonId,
      score: 80,
      expectedVersion: 0,
      idempotencyKey,
      now: fixedNow,
    });

    expect(outcome.replayed).toBe(false);
    expect(outcome.result.version).toBe(1);
    expect(outcome.result.pointsAwarded).toBe(10);
    expect(await repo.getLessonProgress(learnerId, lessonId)).toMatchObject({
      version: 1,
      score: 80,
      status: "completed",
    });
    expect(await repo.getTotalPoints(learnerId)).toBe(10);
  });

  it("replays the same key, rejects a changed payload, and does not award points twice", async () => {
    const repo = repository();
    const { learnerId, lessonId, idempotencyKey } = ids("idem");
    const command = {
      learnerId,
      lessonId,
      score: 70,
      expectedVersion: 0,
      idempotencyKey,
      now: fixedNow,
    };

    const first = await repo.completeLesson(command);
    const replay = await repo.completeLesson({ ...command, now: new Date("2026-10-07T10:00:00.000Z") });
    expect(replay.replayed).toBe(true);
    expect(replay.result).toEqual(first.result);
    expect(await repo.getTotalPoints(learnerId)).toBe(10);

    await expect(
      repo.completeLesson({ ...command, score: 71, now: fixedNow }),
    ).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
    expect(await repo.getTotalPoints(learnerId)).toBe(10);
  });

  it("rejects a stale version and a repeated completion at the current version", async () => {
    const repo = repository();
    const { learnerId, lessonId } = ids("version");
    await repo.completeLesson({
      learnerId,
      lessonId,
      score: 90,
      expectedVersion: 0,
      idempotencyKey: `key-${randomUUID()}`,
      now: fixedNow,
    });

    await expect(
      repo.completeLesson({
        learnerId,
        lessonId,
        score: 90,
        expectedVersion: 0,
        idempotencyKey: `key-${randomUUID()}`,
        now: fixedNow,
      }),
    ).rejects.toMatchObject({ name: "DomainError", code: "VERSION_CONFLICT", currentVersion: 1 });

    await expect(
      repo.completeLesson({
        learnerId,
        lessonId,
        score: 90,
        expectedVersion: 1,
        idempotencyKey: `key-${randomUUID()}`,
        now: fixedNow,
      }),
    ).rejects.toMatchObject({ code: "LESSON_ALREADY_COMPLETED" });
    expect(await repo.getTotalPoints(learnerId)).toBe(10);
  });

  it("awards points once when completions race", async () => {
    const repo = repository();
    const { learnerId, lessonId } = ids("race");
    const attempts = Array.from({ length: 8 }, () =>
      repo.completeLesson({
        learnerId,
        lessonId,
        score: 60,
        expectedVersion: 0,
        idempotencyKey: `key-${randomUUID()}`,
        now: fixedNow,
      }),
    );

    const settled = await Promise.allSettled(attempts);
    const fulfilled = settled.filter((result) => result.status === "fulfilled");
    const rejected = settled.filter((result) => result.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected.length).toBe(7);
    for (const result of rejected) {
      expect(result.reason).toMatchObject({ code: "VERSION_CONFLICT" });
    }
    expect(await repo.getTotalPoints(learnerId)).toBe(10);
    expect(await repo.getLessonProgress(learnerId, lessonId)).toMatchObject({ version: 1 });
  });

  it("replays one of two concurrent requests that share an idempotency key", async () => {
    const repo = repository();
    const { learnerId, lessonId, idempotencyKey } = ids("samereq");
    const command = {
      learnerId,
      lessonId,
      score: 55,
      expectedVersion: 0,
      idempotencyKey,
      now: fixedNow,
    };
    const settled = await Promise.allSettled([repo.completeLesson(command), repo.completeLesson(command)]);
    expect(settled.every((result) => result.status === "fulfilled")).toBe(true);
    const outcomes = settled.map((result) => {
      if (result.status !== "fulfilled") {
        throw new Error("expected both completions to resolve");
      }
      return result.value;
    });
    expect(outcomes.filter((outcome) => outcome.replayed)).toHaveLength(1);
    expect(outcomes.filter((outcome) => !outcome.replayed)).toHaveLength(1);
    expect(await repo.getTotalPoints(learnerId)).toBe(10);
  });

  it("pages lesson progress without treating an empty cursor as the only end signal", async () => {
    const repo = repository();
    const suffix = randomUUID().replaceAll("-", "").slice(0, 12);
    const learnerId = `page${suffix}`;
    for (const lessonId of [`a-${suffix}`, `b-${suffix}`, `c-${suffix}`]) {
      await repo.completeLesson({
        learnerId,
        lessonId,
        score: 40,
        expectedVersion: 0,
        idempotencyKey: `key-${lessonId}`,
        now: fixedNow,
      });
    }

    const first = await repo.listProgress(learnerId, 2, null);
    expect(first.items.map((item) => item.lessonId)).toEqual([`a-${suffix}`, `b-${suffix}`]);
    expect(first.totalPoints).toBe(30);
    expect(first.lastEvaluatedKey).not.toBeNull();

    const second = await repo.listProgress(learnerId, 2, first.lastEvaluatedKey);
    expect(second.items.map((item) => item.lessonId)).toEqual([`c-${suffix}`]);
    expect(second.lastEvaluatedKey).toBeNull();
  });

  it("finds learners who completed one lesson through the sparse index", async () => {
    const repo = repository();
    const suffix = randomUUID().replaceAll("-", "").slice(0, 12);
    const lessonId = `shared-${suffix}`;
    const otherLessonId = `other-${suffix}`;
    const firstLearner = `alpha${suffix}`;
    const secondLearner = `beta${suffix}`;
    const thirdLearner = `gamma${suffix}`;

    await repo.completeLesson({
      learnerId: firstLearner,
      lessonId,
      score: 10,
      expectedVersion: 0,
      idempotencyKey: `key-a-${suffix}`,
      now: fixedNow,
    });
    await repo.completeLesson({
      learnerId: secondLearner,
      lessonId,
      score: 20,
      expectedVersion: 0,
      idempotencyKey: `key-b-${suffix}`,
      now: fixedNow,
    });
    await repo.completeLesson({
      learnerId: thirdLearner,
      lessonId: otherLessonId,
      score: 30,
      expectedVersion: 0,
      idempotencyKey: `key-c-${suffix}`,
      now: fixedNow,
    });

    // DynamoDB Local returning the item does not prove production GSI propagation timing.
    const found = await repo.listCompletionsForLesson(lessonId);
    expect(found.map((item) => item.learnerId).sort()).toEqual([firstLearner, secondLearner].sort());
    expect(found.every((item) => item.lessonId === lessonId)).toBe(true);
  });
});
