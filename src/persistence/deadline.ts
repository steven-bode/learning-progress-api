export const RESPONSE_RESERVE_MS = 250;
export const MAX_COMPLETION_ATTEMPTS = 4;
export const BACKOFF_BASE_MS = 20;
export const BACKOFF_CAP_MS = 200;

export const UNCERTAIN_COMPLETION_MESSAGE =
  "The completion result is uncertain. Retry with the same Idempotency-Key.";

export const RETRY_COMPLETION_MESSAGE =
  "The completion could not be finished. Retry with the same Idempotency-Key.";

export const RETRY_READ_MESSAGE = "The request could not be completed in time. Retry.";

type Schedule = (callback: () => void, ms: number) => () => void;

const defaultSchedule: Schedule = (callback, ms) => {
  const timer = setTimeout(callback, ms);
  timer.unref?.();
  return () => {
    clearTimeout(timer);
  };
};

export function backoffDelayMs(attempt: number, random: () => number): number {
  const ceiling = Math.min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * 2 ** attempt);
  return Math.floor(random() * ceiling);
}

export class InvocationDeadline {
  readonly signal: AbortSignal;
  private readonly controller = new AbortController();
  private cancelTimer?: () => void;

  constructor(
    private readonly remainingTimeMs: () => number,
    private readonly reserveMs = RESPONSE_RESERVE_MS,
    schedule: Schedule = defaultSchedule,
  ) {
    this.signal = this.controller.signal;
    const budget = this.budgetMs();
    if (budget <= 0) {
      this.controller.abort();
      return;
    }
    this.cancelTimer = schedule(() => {
      this.controller.abort();
    }, budget);
  }

  budgetMs(): number {
    return this.remainingTimeMs() - this.reserveMs;
  }

  hasBudget(): boolean {
    return this.budgetMs() > 0 && !this.signal.aborted;
  }

  dispose(): void {
    this.cancelTimer?.();
  }
}

export function isUncertainOutcome(error: unknown): boolean {
  return error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError");
}
