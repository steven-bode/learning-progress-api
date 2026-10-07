export type ErrorCode =
  | "VALIDATION_ERROR"
  | "MISSING_IDENTITY"
  | "FORBIDDEN"
  | "PROGRESS_NOT_FOUND"
  | "NOT_FOUND"
  | "VERSION_CONFLICT"
  | "LESSON_ALREADY_COMPLETED"
  | "IDEMPOTENCY_CONFLICT"
  | "TEMPORARILY_UNAVAILABLE"
  | "INTERNAL_ERROR";

export interface ValidationDetail {
  path: string;
  message: string;
}

export class ApiError extends Error {
  readonly details?: ValidationDetail[];
  readonly currentVersion?: number;

  constructor(
    readonly code: ErrorCode,
    readonly statusCode: number,
    message: string,
    options?: { details?: ValidationDetail[]; currentVersion?: number },
  ) {
    super(message);
    this.name = "ApiError";
    if (options?.details && options.details.length > 0) {
      this.details = options.details;
    }
    if (options?.currentVersion !== undefined) {
      this.currentVersion = options.currentVersion;
    }
  }
}
