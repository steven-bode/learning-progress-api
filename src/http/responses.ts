import type { APIGatewayProxyStructuredResultV2 } from "aws-lambda";
import { DomainError } from "../domain/errors.js";
import { StorageError } from "../persistence/errors.js";
import { ApiError } from "./api-error.js";

export interface ErrorBody {
  error: {
    code: string;
    message: string;
    requestId: string;
    details?: { path: string; message: string }[];
    currentVersion?: number;
  };
}

export function jsonResult(
  statusCode: number,
  body: unknown,
  headers?: Record<string, string>,
): APIGatewayProxyStructuredResultV2 {
  return {
    statusCode,
    headers: {
      "content-type": "application/json",
      "cache-control": "no-store",
      ...headers,
    },
    body: JSON.stringify(body),
  };
}

export function errorResult(error: ApiError, requestId: string): APIGatewayProxyStructuredResultV2 {
  const body: ErrorBody = {
    error: {
      code: error.code,
      message: error.message,
      requestId,
      ...(error.details ? { details: error.details } : {}),
      ...(error.currentVersion !== undefined ? { currentVersion: error.currentVersion } : {}),
    },
  };
  return jsonResult(error.statusCode, body);
}

export function toApiError(error: unknown): ApiError {
  if (error instanceof ApiError) {
    return error;
  }
  if (error instanceof DomainError) {
    return new ApiError(error.code, statusForDomain(error.code), error.message, {
      ...(error.currentVersion !== undefined ? { currentVersion: error.currentVersion } : {}),
    });
  }
  return new ApiError("INTERNAL_ERROR", 500, "Unexpected error.");
}

function statusForDomain(code: DomainError["code"]): number {
  if (code === "TEMPORARILY_UNAVAILABLE") {
    return 503;
  }
  return 409;
}

export function logContext(error: unknown): { errorName?: string; cancellationCodes?: string[] } {
  if (error instanceof DomainError && error.cancellationCodes) {
    return { cancellationCodes: error.cancellationCodes };
  }
  if (error instanceof StorageError) {
    const causeName = error.cause instanceof Error ? error.cause.name : undefined;
    return {
      ...(causeName ? { errorName: causeName } : { errorName: error.name }),
      ...(error.cancellationCodes ? { cancellationCodes: error.cancellationCodes } : {}),
    };
  }
  if (error instanceof Error && !(error instanceof ApiError) && !(error instanceof DomainError)) {
    return { errorName: error.name };
  }
  return {};
}
