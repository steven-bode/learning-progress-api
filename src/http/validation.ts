import { Buffer } from "node:buffer";
import { z } from "zod";
import { ApiError, type ValidationDetail } from "./api-error.js";
import {
  DEFAULT_PAGE_LIMIT,
  IDEMPOTENCY_KEY_PATTERN,
  LESSON_ID_PATTERN,
  MAX_BODY_CHARS,
  MAX_EXPECTED_VERSION,
  MAX_PAGE_LIMIT,
} from "../ids.js";

export const completionBodySchema = z.strictObject({
  score: z
    .number()
    .int("Score must be an integer from 0 to 100.")
    .min(0, "Score must be an integer from 0 to 100.")
    .max(100, "Score must be an integer from 0 to 100."),
  expectedVersion: z
    .number()
    .int("expectedVersion must be an integer from 0.")
    .min(0, "expectedVersion must be an integer from 0.")
    .max(MAX_EXPECTED_VERSION, "expectedVersion is too large."),
});

export type CompletionBody = z.infer<typeof completionBodySchema>;

const cursorSchema = z.strictObject({
  v: z.literal(1),
  pk: z.string().min(1),
  sk: z.string().min(1),
});

export interface PageCursor {
  v: 1;
  pk: string;
  sk: string;
}

export function validationDetails(error: z.ZodError): ValidationDetail[] {
  return error.issues.map((issue) => ({
    path: issue.path.map(String).join("."),
    message: issue.message,
  }));
}

export function parseCompletionBody(value: unknown): CompletionBody {
  const parsed = completionBodySchema.safeParse(value);
  if (!parsed.success) {
    throw new ApiError("VALIDATION_ERROR", 400, "The request body is invalid.", {
      details: validationDetails(parsed.error),
    });
  }
  return parsed.data;
}

export function parseLessonId(value: string | undefined): string {
  if (!value || !LESSON_ID_PATTERN.test(value)) {
    throw new ApiError("VALIDATION_ERROR", 400, "The lesson id is invalid.", {
      details: [{ path: "lessonId", message: "Use 1 to 80 letters, numbers, '_' or '-'." }],
    });
  }
  return value;
}

export function parseIdempotencyKey(value: string | undefined): string {
  if (!value) {
    throw new ApiError("VALIDATION_ERROR", 400, "Idempotency-Key is required.", {
      details: [{ path: "Idempotency-Key", message: "Idempotency-Key is required." }],
    });
  }
  if (!IDEMPOTENCY_KEY_PATTERN.test(value)) {
    throw new ApiError("VALIDATION_ERROR", 400, "Idempotency-Key is invalid.", {
      details: [
        {
          path: "Idempotency-Key",
          message: "Use 1 to 128 letters, numbers, '_' or '-'.",
        },
      ],
    });
  }
  return value;
}

export function parsePageLimit(value: string | undefined): number {
  if (value === undefined) {
    return DEFAULT_PAGE_LIMIT;
  }
  if (!/^[1-9][0-9]*$/.test(value)) {
    throw new ApiError("VALIDATION_ERROR", 400, "The page limit is invalid.", {
      details: [{ path: "limit", message: `Use an integer from 1 to ${MAX_PAGE_LIMIT}.` }],
    });
  }
  const limit = Number(value);
  if (limit > MAX_PAGE_LIMIT) {
    throw new ApiError("VALIDATION_ERROR", 400, "The page limit is invalid.", {
      details: [{ path: "limit", message: `Use an integer from 1 to ${MAX_PAGE_LIMIT}.` }],
    });
  }
  return limit;
}

export function readJsonBody(input: { body?: string; isBase64Encoded: boolean }): unknown {
  if (!input.body) {
    throw new ApiError("VALIDATION_ERROR", 400, "Request body is required.", {
      details: [{ path: "body", message: "Request body is required." }],
    });
  }

  const text = input.isBase64Encoded ? Buffer.from(input.body, "base64").toString("utf8") : input.body;
  if (text.length > MAX_BODY_CHARS) {
    throw new ApiError("VALIDATION_ERROR", 400, "Request body is too large.", {
      details: [{ path: "body", message: "Request body is too large." }],
    });
  }

  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new ApiError("VALIDATION_ERROR", 400, "Request body must be JSON.", {
      details: [{ path: "body", message: "Request body must be JSON." }],
    });
  }
}

export function encodeCursor(key: { pk: string; sk: string }): string {
  return Buffer.from(JSON.stringify({ v: 1, pk: key.pk, sk: key.sk }), "utf8").toString("base64url");
}

export function decodeCursor(value: string): PageCursor {
  if (value.length === 0 || value.length > 1_024) {
    throw new ApiError("VALIDATION_ERROR", 400, "The cursor is invalid.", {
      details: [{ path: "cursor", message: "The cursor is invalid." }],
    });
  }
  let json: unknown;
  try {
    json = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as unknown;
  } catch {
    throw new ApiError("VALIDATION_ERROR", 400, "The cursor is invalid.", {
      details: [{ path: "cursor", message: "The cursor is invalid." }],
    });
  }

  const parsed = cursorSchema.safeParse(json);
  if (!parsed.success) {
    throw new ApiError("VALIDATION_ERROR", 400, "The cursor is invalid.", {
      details: [{ path: "cursor", message: "The cursor is invalid." }],
    });
  }
  return parsed.data;
}

export function cursorFromLastEvaluatedKey(key: { pk: string; sk: string } | null): string | null {
  return key ? encodeCursor(key) : null;
}
