const RETRYABLE_CANCELLATION_CODES = new Set([
  "TransactionConflict",
  "ThrottlingError",
  "ProvisionedThroughputExceeded",
]);

export type CancellationDecision = "idempotency" | "progress" | "retry" | "failure";

export function decideCancellation(codes: readonly string[]): CancellationDecision {
  const idempotency = codes[0] ?? "";
  const progress = codes[1] ?? "";

  if (idempotency === "ConditionalCheckFailed") {
    return "idempotency";
  }
  if (progress === "ConditionalCheckFailed") {
    return "progress";
  }
  if (codes.some((code) => RETRYABLE_CANCELLATION_CODES.has(code))) {
    return "retry";
  }
  return "failure";
}
