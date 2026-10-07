import { describe, expect, it } from "vitest";
import { ApiError } from "../../src/http/api-error.js";
import { resolveLearnerId } from "../../src/http/auth.js";
import type { ProgressHttpEvent } from "../../src/http/event.js";
import { cursorFromLastEvaluatedKey, encodeCursor } from "../../src/http/validation.js";
import { toApiError } from "../../src/http/responses.js";
import {
  decodeCursor,
  parseCompletionBody,
  parseIdempotencyKey,
  parseLessonId,
  parsePageLimit,
  readJsonBody,
} from "../../src/http/validation.js";
import { gatewayEvent } from "../helpers/events.js";

describe("request validation", () => {
  it("accepts a completion body and rejects unknown learner identity fields", () => {
    expect(parseCompletionBody({ score: 0, expectedVersion: 0 })).toEqual({
      score: 0,
      expectedVersion: 0,
    });
    expect(parseCompletionBody({ score: 100, expectedVersion: 2 })).toEqual({
      score: 100,
      expectedVersion: 2,
    });

    expect(() => parseCompletionBody({ score: 80, expectedVersion: 0, learnerId: "other-learner" })).toThrow(
      ApiError,
    );
    try {
      parseCompletionBody({ score: 80, expectedVersion: 0, learnerId: "other-learner" });
    } catch (error) {
      expect(error).toBeInstanceOf(ApiError);
      const apiError = error as ApiError;
      expect(apiError.statusCode).toBe(400);
      expect(JSON.stringify(apiError.details)).not.toContain("other-learner");
    }
  });

  it("rejects scores and versions outside the documented range", () => {
    for (const body of [{ score: -1, expectedVersion: 0 }, { score: 101, expectedVersion: 0 }, { score: 1.5, expectedVersion: 0 }, { score: 10, expectedVersion: -1 }, { score: "10", expectedVersion: 0 }]) {
      expect(() => parseCompletionBody(body)).toThrow(ApiError);
    }
  });

  it("validates lesson ids, idempotency keys, limits, and JSON bodies", () => {
    expect(parseLessonId("intro-1")).toBe("intro-1");
    expect(() => parseLessonId("bad/id")).toThrow(ApiError);
    expect(() => parseLessonId(undefined)).toThrow(ApiError);

    expect(parseIdempotencyKey("key_1")).toBe("key_1");
    expect(() => parseIdempotencyKey(undefined)).toThrow(ApiError);
    expect(() => parseIdempotencyKey("has space")).toThrow(ApiError);

    expect(parsePageLimit(undefined)).toBe(20);
    expect(parsePageLimit("1")).toBe(1);
    expect(parsePageLimit("50")).toBe(50);
    expect(() => parsePageLimit("0")).toThrow(ApiError);
    expect(() => parsePageLimit("51")).toThrow(ApiError);
    expect(() => parsePageLimit("2.5")).toThrow(ApiError);

    expect(readJsonBody({ body: "{\"score\":1}", isBase64Encoded: false })).toEqual({ score: 1 });
    expect(readJsonBody({ body: Buffer.from("{\"score\":1}").toString("base64"), isBase64Encoded: true })).toEqual({
      score: 1,
    });
    expect(() => readJsonBody({ body: "not-json", isBase64Encoded: false })).toThrow(ApiError);
    expect(() => readJsonBody({ isBase64Encoded: false })).toThrow(ApiError);
  });

  it("round-trips a cursor and still returns one for an empty page", () => {
    const key = { pk: "LEARNER#learner-1", sk: "LESSON#intro" };
    expect(decodeCursor(encodeCursor(key))).toEqual({ v: 1, pk: key.pk, sk: key.sk });
    expect(cursorFromLastEvaluatedKey(key)).not.toBeNull();
    expect(cursorFromLastEvaluatedKey(null)).toBeNull();
    expect(() => decodeCursor("not-a-cursor")).toThrow(ApiError);
  });
});

describe("identity", () => {
  it("uses the local header only in local mode and the JWT subject otherwise", () => {
    const localEvent = gatewayEvent({
      routeKey: "GET /me/progress",
      headers: { "x-local-learner-id": "learner-1", authorization: "Bearer secret-token" },
    });
    expect(resolveLearnerId(localEvent, "local")).toBe("learner-1");
    expect(() => resolveLearnerId(gatewayEvent({ routeKey: "GET /me/progress" }), "local")).toThrow(ApiError);

    const jwtEvent = gatewayEvent({
      routeKey: "GET /me/progress",
      headers: { "x-local-learner-id": "learner-1" },
      learnerSub: "jwt-learner",
    });
    expect(resolveLearnerId(jwtEvent, "jwt")).toBe("jwt-learner");
    expect(() => resolveLearnerId(localEvent, "jwt")).toThrow(ApiError);
  });

  it("hides unexpected error details from clients", () => {
    const error = toApiError(new Error("table arn and secret stack"));
    expect(error.code).toBe("INTERNAL_ERROR");
    expect(error.message).toBe("Unexpected error.");
    expect(error.message).not.toContain("secret");
  });
});

describe("event shape", () => {
  it("builds a payload format 2.0 event", () => {
    const event: ProgressHttpEvent = gatewayEvent({ routeKey: "GET /me/progress" });
    expect(event.version).toBe("2.0");
    expect(event.requestContext.http.method).toBe("GET");
  });
});
