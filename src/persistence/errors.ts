export class StorageError extends Error {
  readonly cancellationCodes?: string[];

  constructor(message: string, options?: { cause?: unknown; cancellationCodes?: string[] }) {
    super(message, options?.cause !== undefined ? { cause: options.cause } : {});
    this.name = "StorageError";
    if (options?.cancellationCodes) {
      this.cancellationCodes = options.cancellationCodes;
    }
  }
}
