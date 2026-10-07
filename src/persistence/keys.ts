import { IDEMPOTENCY_KEY_PATTERN, LEARNER_ID_PATTERN, LESSON_ID_PATTERN } from "../ids.js";
import { StorageError } from "./errors.js";

export const LESSON_PREFIX = "LESSON#";
export const REQUEST_PREFIX = "REQUEST#";
export const SUMMARY_SK = "SUMMARY";
export const COMPLETIONS_INDEX = "completions-by-lesson";

function assertPart(value: string, pattern: RegExp): string {
  if (!pattern.test(value)) {
    throw new StorageError("unsafe_key");
  }
  return value;
}

export function learnerPk(learnerId: string): string {
  return `LEARNER#${assertPart(learnerId, LEARNER_ID_PATTERN)}`;
}

export function lessonSk(lessonId: string): string {
  return `${LESSON_PREFIX}${assertPart(lessonId, LESSON_ID_PATTERN)}`;
}

export function requestSk(idempotencyKey: string): string {
  return `${REQUEST_PREFIX}${assertPart(idempotencyKey, IDEMPOTENCY_KEY_PATTERN)}`;
}

export function lessonIndexPk(lessonId: string): string {
  return `${LESSON_PREFIX}${assertPart(lessonId, LESSON_ID_PATTERN)}`;
}

export function learnerIndexSk(learnerId: string): string {
  return `LEARNER#${assertPart(learnerId, LEARNER_ID_PATTERN)}`;
}
