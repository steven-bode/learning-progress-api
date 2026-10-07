import type { APIGatewayProxyEventHeaders } from "aws-lambda";
import { LEARNER_ID_PATTERN } from "../ids.js";
import { ApiError } from "./api-error.js";
import type { ProgressHttpEvent } from "./event.js";

export function headerValue(headers: APIGatewayProxyEventHeaders | undefined, name: string): string | undefined {
  if (!headers) {
    return undefined;
  }
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === name && typeof value === "string" && value.length > 0) {
      return value;
    }
  }
  return undefined;
}

export function resolveLearnerId(event: ProgressHttpEvent, authMode: "local" | "jwt"): string {
  const missing = new ApiError(
    "MISSING_IDENTITY",
    401,
    "Authentication did not provide a learner identity.",
  );

  if (authMode === "local") {
    const learnerId = headerValue(event.headers, "x-local-learner-id");
    if (!learnerId || !LEARNER_ID_PATTERN.test(learnerId)) {
      throw missing;
    }
    return learnerId;
  }

  // Use the verified identity instead of trusting the request body.
  const sub = event.requestContext.authorizer?.jwt?.claims?.sub;
  if (typeof sub !== "string" || !LEARNER_ID_PATTERN.test(sub)) {
    throw missing;
  }
  return sub;
}
