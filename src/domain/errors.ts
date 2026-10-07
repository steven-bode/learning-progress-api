export type DomainCode =
  | "VERSION_CONFLICT"
  | "LESSON_ALREADY_COMPLETED"
  | "IDEMPOTENCY_CONFLICT"
  | "TEMPORARILY_UNAVAILABLE";

export class DomainError extends Error {
  readonly currentVersion?: number;
  readonly cancellationCodes?: string[];

  constructor(
    readonly code: DomainCode,
    message: string,
    options?: { currentVersion?: number; cancellationCodes?: string[] },
  ) {
    super(message);
    this.name = "DomainError";
    if (options?.currentVersion !== undefined) {
      this.currentVersion = options.currentVersion;
    }
    if (options?.cancellationCodes) {
      this.cancellationCodes = options.cancellationCodes;
    }
  }
}
