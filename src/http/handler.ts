import { randomUUID } from "node:crypto";
import type { APIGatewayProxyStructuredResultV2 } from "aws-lambda";
import { loadConfig } from "../config.js";
import { getDocumentClient } from "../persistence/client.js";
import { InvocationDeadline } from "../persistence/deadline.js";
import { learnerPk, LESSON_PREFIX } from "../persistence/keys.js";
import { ProgressRepository } from "../persistence/repository.js";
import { ApiError } from "./api-error.js";
import { headerValue, resolveLearnerId } from "./auth.js";
import type { ProgressHttpEvent } from "./event.js";
import { writeLog } from "./logging.js";
import { errorResult, jsonResult, logContext, toApiError } from "./responses.js";
import {
  cursorFromLastEvaluatedKey,
  decodeCursor,
  parseCompletionBody,
  parseIdempotencyKey,
  parseLessonId,
  parsePageLimit,
  readJsonBody,
} from "./validation.js";

const GET_LESSON = "GET /me/lessons/{lessonId}/progress";
const LIST_PROGRESS = "GET /me/progress";
const COMPLETE_LESSON = "POST /me/lessons/{lessonId}/completion";

export async function handler(
  event: ProgressHttpEvent,
  context: { getRemainingTimeInMillis: () => number },
): Promise<APIGatewayProxyStructuredResultV2> {
  const started = Date.now();
  const requestId = safeRequestId(event.requestContext?.requestId);
  const operation = operationName(event.routeKey);
  const deadline = new InvocationDeadline(() => context.getRemainingTimeInMillis());

  try {
    const config = loadConfig(process.env);
    const repository = new ProgressRepository(getDocumentClient(), config.tableName);
    const learnerId = resolveLearnerId(event, config.authMode);
    const response = await dispatch(event, repository, learnerId, deadline);
    writeLog({
      level: "info",
      requestId,
      operation,
      durationMs: Date.now() - started,
      statusCode: response.statusCode ?? 200,
    });
    return response;
  } catch (error) {
    const apiError = toApiError(error);
    const logged = logContext(error);
    writeLog({
      level: apiError.statusCode >= 500 ? "error" : "info",
      requestId,
      operation,
      durationMs: Date.now() - started,
      statusCode: apiError.statusCode,
      errorCategory: apiError.code,
      ...logged,
    });
    return errorResult(apiError, requestId);
  } finally {
    deadline.dispose();
  }
}

async function dispatch(
  event: ProgressHttpEvent,
  repository: ProgressRepository,
  learnerId: string,
  deadline: InvocationDeadline,
): Promise<APIGatewayProxyStructuredResultV2> {
  switch (event.routeKey) {
    case GET_LESSON:
      return getLessonProgress(event, repository, learnerId, deadline);
    case LIST_PROGRESS:
      return listProgress(event, repository, learnerId, deadline);
    case COMPLETE_LESSON:
      return completeLesson(event, repository, learnerId, deadline);
    default:
      throw new ApiError("NOT_FOUND", 404, "No route matches this request.");
  }
}

async function getLessonProgress(
  event: ProgressHttpEvent,
  repository: ProgressRepository,
  learnerId: string,
  deadline: InvocationDeadline,
): Promise<APIGatewayProxyStructuredResultV2> {
  const lessonId = parseLessonId(event.pathParameters?.lessonId);
  const progress = await repository.getLessonProgress(learnerId, lessonId, deadline);
  if (!progress) {
    throw new ApiError(
      "PROGRESS_NOT_FOUND",
      404,
      "No progress exists for this lesson. Use expectedVersion 0 to complete it.",
    );
  }
  return jsonResult(200, {
    lessonId: progress.lessonId,
    status: progress.status,
    score: progress.score,
    version: progress.version,
    pointsAwarded: progress.pointsAwarded,
    completedAt: progress.completedAt,
  });
}

async function listProgress(
  event: ProgressHttpEvent,
  repository: ProgressRepository,
  learnerId: string,
  deadline: InvocationDeadline,
): Promise<APIGatewayProxyStructuredResultV2> {
  const limit = parsePageLimit(event.queryStringParameters?.limit);
  const cursorValue = event.queryStringParameters?.cursor;
  const startKey = cursorValue === undefined ? null : authorizeCursor(cursorValue, learnerId);
  const page = await repository.listProgress(learnerId, limit, startKey, deadline);
  return jsonResult(200, {
    totalPoints: page.totalPoints,
    items: page.items.map((item) => ({
      lessonId: item.lessonId,
      status: item.status,
      score: item.score,
      version: item.version,
      pointsAwarded: item.pointsAwarded,
      completedAt: item.completedAt,
    })),
    // An empty page is not the end. Only a missing LastEvaluatedKey is.
    nextCursor: cursorFromLastEvaluatedKey(page.lastEvaluatedKey),
  });
}

async function completeLesson(
  event: ProgressHttpEvent,
  repository: ProgressRepository,
  learnerId: string,
  deadline: InvocationDeadline,
): Promise<APIGatewayProxyStructuredResultV2> {
  const lessonId = parseLessonId(event.pathParameters?.lessonId);
  const idempotencyKey = parseIdempotencyKey(headerValue(event.headers, "idempotency-key"));
  const body = parseCompletionBody(readJsonBody(event));
  const outcome = await repository.completeLesson(
    {
      learnerId,
      lessonId,
      score: body.score,
      expectedVersion: body.expectedVersion,
      idempotencyKey,
      now: new Date(),
    },
    deadline,
  );

  return jsonResult(outcome.statusCode, outcome.result, {
    ...(outcome.replayed ? { "idempotent-replayed": "true" } : {}),
  });
}

function authorizeCursor(value: string, learnerId: string): { pk: string; sk: string } {
  const cursor = decodeCursor(value);
  if (cursor.pk !== learnerPk(learnerId)) {
    throw new ApiError("FORBIDDEN", 403, "The cursor does not belong to the authenticated learner.");
  }
  if (!cursor.sk.startsWith(LESSON_PREFIX)) {
    throw new ApiError("VALIDATION_ERROR", 400, "The cursor is not valid for this query.", {
      details: [{ path: "cursor", message: "The cursor is not valid for this query." }],
    });
  }
  return { pk: cursor.pk, sk: cursor.sk };
}

function operationName(routeKey: string | undefined): string {
  switch (routeKey) {
    case GET_LESSON:
      return "getLessonProgress";
    case LIST_PROGRESS:
      return "listProgress";
    case COMPLETE_LESSON:
      return "completeLesson";
    default:
      return "unknown";
  }
}

function safeRequestId(value: string | undefined): string {
  if (value && /^[A-Za-z0-9-]{1,128}$/.test(value)) {
    return value;
  }
  return randomUUID();
}
