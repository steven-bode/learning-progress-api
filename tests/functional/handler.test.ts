import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { APIGatewayProxyStructuredResultV2 } from "aws-lambda";
import { handler } from "../../src/http/handler.js";
import { encodeCursor } from "../../src/http/validation.js";
import { learnerPk } from "../../src/persistence/keys.js";
import { gatewayEvent } from "../helpers/events.js";

const lambdaContext = { getRemainingTimeInMillis: () => 10_000 };

function invoke(event: Parameters<typeof handler>[0]) {
  return handler(event, lambdaContext);
}

function bodyOf(response: APIGatewayProxyStructuredResultV2): Record<string, unknown> {
  if (!response.body) {
    throw new Error("missing response body");
  }
  return JSON.parse(response.body) as Record<string, unknown>;
}

function errorCode(response: APIGatewayProxyStructuredResultV2): string {
  const body = bodyOf(response);
  const error = body.error as { code?: string } | undefined;
  return error?.code ?? "";
}

async function complete(input: {
  learnerId: string;
  lessonId: string;
  score?: number;
  expectedVersion?: number;
  idempotencyKey?: string;
  extraBody?: Record<string, unknown>;
  requestId?: string;
}): Promise<APIGatewayProxyStructuredResultV2> {
  return invoke(
    gatewayEvent({
      routeKey: "POST /me/lessons/{lessonId}/completion",
      rawPath: `/me/lessons/${input.lessonId}/completion`,
      pathParameters: { lessonId: input.lessonId },
      headers: {
        "content-type": "application/json",
        "idempotency-key": input.idempotencyKey ?? `key-${randomUUID()}`,
        "x-local-learner-id": input.learnerId,
        authorization: "Bearer secret-token-value",
      },
      requestId: input.requestId ?? "req-complete",
      body: JSON.stringify({
        score: input.score ?? 80,
        expectedVersion: input.expectedVersion ?? 0,
        ...input.extraBody,
      }),
    }),
  );
}

describe("HTTP handler", () => {
  afterEach(() => {
    process.env.AUTH_MODE = "local";
    vi.restoreAllMocks();
  });

  it("completes a lesson, replays the same request, and reports conflicts", async () => {
    const learnerId = `http${randomUUID().replaceAll("-", "").slice(0, 12)}`;
    const lessonId = "intro";
    const idempotencyKey = `key-${randomUUID()}`;

    const missing = await invoke(
      gatewayEvent({
        routeKey: "GET /me/lessons/{lessonId}/progress",
        pathParameters: { lessonId },
        headers: { "x-local-learner-id": learnerId },
        requestId: "req-missing",
      }),
    );
    expect(missing.statusCode).toBe(404);
    expect(bodyOf(missing)).toMatchObject({
      error: {
        code: "PROGRESS_NOT_FOUND",
        requestId: "req-missing",
      },
    });

    const created = await complete({ learnerId, lessonId, idempotencyKey, requestId: "req-created" });
    expect(created.statusCode).toBe(201);
    expect(created.headers?.["idempotent-replayed"]).toBeUndefined();
    expect(bodyOf(created)).toMatchObject({
      lessonId,
      status: "completed",
      score: 80,
      version: 1,
      pointsAwarded: 10,
    });

    const replay = await complete({ learnerId, lessonId, idempotencyKey, requestId: "req-replay" });
    expect(replay.statusCode).toBe(201);
    expect(replay.headers?.["idempotent-replayed"]).toBe("true");
    expect(bodyOf(replay)).toEqual(bodyOf(created));

    const changed = await complete({
      learnerId,
      lessonId,
      idempotencyKey,
      score: 81,
      requestId: "req-changed",
    });
    expect(changed.statusCode).toBe(409);
    expect(errorCode(changed)).toBe("IDEMPOTENCY_CONFLICT");

    const stale = await complete({
      learnerId,
      lessonId,
      expectedVersion: 0,
      idempotencyKey: `key-${randomUUID()}`,
      requestId: "req-stale",
    });
    expect(stale.statusCode).toBe(409);
    expect(bodyOf(stale)).toMatchObject({
      error: {
        code: "VERSION_CONFLICT",
        requestId: "req-stale",
        currentVersion: 1,
      },
    });
    expect(JSON.stringify(bodyOf(stale))).not.toContain("stack");

    const already = await complete({
      learnerId,
      lessonId,
      expectedVersion: 1,
      idempotencyKey: `key-${randomUUID()}`,
      requestId: "req-already",
    });
    expect(already.statusCode).toBe(409);
    expect(errorCode(already)).toBe("LESSON_ALREADY_COMPLETED");

    const listed = await invoke(
      gatewayEvent({
        routeKey: "GET /me/progress",
        headers: { "x-local-learner-id": learnerId },
        requestId: "req-list",
      }),
    );
    expect(listed.statusCode).toBe(200);
    expect(bodyOf(listed)).toMatchObject({
      totalPoints: 10,
      nextCursor: null,
    });
  });

  it("rejects invalid input, a foreign cursor, and a missing identity", async () => {
    const learnerId = `bad${randomUUID().replaceAll("-", "").slice(0, 12)}`;
    const invalidScore = await complete({ learnerId, lessonId: "intro", score: 101 });
    expect(invalidScore.statusCode).toBe(400);
    expect(errorCode(invalidScore)).toBe("VALIDATION_ERROR");

    const withLearner = await complete({
      learnerId,
      lessonId: "intro",
      extraBody: { learnerId: "someone-else" },
    });
    expect(withLearner.statusCode).toBe(400);
    expect(JSON.stringify(bodyOf(withLearner))).not.toContain("someone-else");

    const missingKey = await invoke(
      gatewayEvent({
        routeKey: "POST /me/lessons/{lessonId}/completion",
        pathParameters: { lessonId: "intro" },
        headers: { "x-local-learner-id": learnerId },
        body: JSON.stringify({ score: 10, expectedVersion: 0 }),
        requestId: "req-no-key",
      }),
    );
    expect(missingKey.statusCode).toBe(400);
    expect(errorCode(missingKey)).toBe("VALIDATION_ERROR");

    const missingIdentity = await invoke(
      gatewayEvent({
        routeKey: "GET /me/progress",
        requestId: "req-no-id",
      }),
    );
    expect(missingIdentity.statusCode).toBe(401);
    expect(errorCode(missingIdentity)).toBe("MISSING_IDENTITY");

    process.env.AUTH_MODE = "jwt";
    const ignoredLocalHeader = await invoke(
      gatewayEvent({
        routeKey: "GET /me/progress",
        headers: { "x-local-learner-id": learnerId },
        requestId: "req-jwt-missing",
      }),
    );
    expect(ignoredLocalHeader.statusCode).toBe(401);

    const foreignCursor = encodeCursor({
      pk: learnerPk("other-learner"),
      sk: "LESSON#intro",
    });
    process.env.AUTH_MODE = "local";
    const forbidden = await invoke(
      gatewayEvent({
        routeKey: "GET /me/progress",
        headers: { "x-local-learner-id": learnerId },
        queryStringParameters: { cursor: foreignCursor },
        requestId: "req-forbidden",
      }),
    );
    expect(forbidden.statusCode).toBe(403);
    expect(errorCode(forbidden)).toBe("FORBIDDEN");

    const malformed = await invoke(
      gatewayEvent({
        routeKey: "GET /me/progress",
        headers: { "x-local-learner-id": learnerId },
        queryStringParameters: { cursor: "%%%" },
      }),
    );
    expect(malformed.statusCode).toBe(400);
  });

  it("pages results for the authenticated learner", async () => {
    const learnerId = `pages${randomUUID().replaceAll("-", "").slice(0, 10)}`;
    for (const lessonId of ["a-lesson", "b-lesson", "c-lesson"]) {
      const response = await complete({ learnerId, lessonId, score: 50 });
      expect(response.statusCode).toBe(201);
    }

    const first = await invoke(
      gatewayEvent({
        routeKey: "GET /me/progress",
        headers: { "x-local-learner-id": learnerId },
        queryStringParameters: { limit: "2" },
      }),
    );
    const firstBody = bodyOf(first);
    const firstItems = firstBody.items as { lessonId: string }[];
    expect(firstItems.map((item) => item.lessonId)).toEqual(["a-lesson", "b-lesson"]);
    expect(typeof firstBody.nextCursor).toBe("string");

    const second = await invoke(
      gatewayEvent({
        routeKey: "GET /me/progress",
        headers: { "x-local-learner-id": learnerId },
        queryStringParameters: { limit: "2", cursor: String(firstBody.nextCursor) },
      }),
    );
    const secondBody = bodyOf(second);
    expect(secondBody.items).toEqual([
      expect.objectContaining({ lessonId: "c-lesson" }),
    ]);
    expect(secondBody.nextCursor).toBeNull();
    expect(secondBody.totalPoints).toBe(30);
  });

  it("awards points once for concurrent handler calls", async () => {
    const learnerId = `race${randomUUID().replaceAll("-", "").slice(0, 12)}`;
    const responses = await Promise.all(
      Array.from({ length: 6 }, () => complete({ learnerId, lessonId: "race-lesson", score: 40 })),
    );
    const created = responses.filter((response) => response.statusCode === 201);
    const conflicts = responses.filter((response) => response.statusCode === 409);
    expect(created).toHaveLength(1);
    expect(conflicts).toHaveLength(5);
    expect(conflicts.every((response) => errorCode(response) === "VERSION_CONFLICT")).toBe(true);

    const listed = await invoke(
      gatewayEvent({
        routeKey: "GET /me/progress",
        headers: { "x-local-learner-id": learnerId },
      }),
    );
    expect(bodyOf(listed).totalPoints).toBe(10);
  });

  it("does not log tokens, idempotency keys, or the request body", async () => {
    const lines: string[] = [];
    vi.spyOn(console, "log").mockImplementation((line: unknown) => {
      lines.push(String(line));
    });
    vi.spyOn(console, "error").mockImplementation((line: unknown) => {
      lines.push(String(line));
    });

    const idempotencyKey = "log-key-should-stay-out";
    await complete({
      learnerId: "loggerlearner",
      lessonId: "intro",
      idempotencyKey,
      requestId: "req-log",
    });

    const logged = lines.join("\n");
    expect(logged).toContain("req-log");
    expect(logged).toContain("completeLesson");
    expect(logged).not.toContain("secret-token-value");
    expect(logged).not.toContain(idempotencyKey);
    expect(logged).not.toContain("expectedVersion");
  });
});
