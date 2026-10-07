export const LEARNER_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:|-]{0,127}$/;
export const LESSON_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/;
export const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

export const DEFAULT_PAGE_LIMIT = 20;
export const MAX_PAGE_LIMIT = 50;
export const MAX_BODY_CHARS = 4_096;
export const MAX_EXPECTED_VERSION = 1_000_000;
