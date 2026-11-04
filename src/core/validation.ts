import { saveOutcome } from "../db/store.ts";
import type {
  Attempt,
  AttemptError,
  DatabaseBinding,
  ErrorSource,
  JsonValue,
  OrdoContext,
} from "../types.ts";

export function createContext(
  db: DatabaseBinding,
  attempt: Attempt,
  params: JsonValue,
  result: JsonValue | undefined,
  feedback?: OrdoContext["feedback"],
): OrdoContext {
  return Object.freeze({
    goalId: attempt.goalId,
    stepName: attempt.stepName,
    attemptId: attempt.id,
    ...(feedback ? { feedback: Object.freeze({ ...feedback }) } : {}),
    input() {
      return structuredClone({ params, result });
    },
    async complete(value: unknown): Promise<void> {
      if (attempt.action !== "run")
        throw new TypeError("complete() is only available to run");
      assertJson(value, "Business result");
      await saveOutcome(db, attempt.id, "run", value);
    },
    async ok(): Promise<void> {
      if (arguments.length !== 0)
        throw new TypeError("ok() does not accept arguments");
      if (attempt.action !== "validate" && attempt.action !== "evaluate")
        throw new TypeError("ok() is only available to checks");
      await saveOutcome(db, attempt.id, attempt.action, { ok: true });
    },
    async ng(reason: string): Promise<void> {
      if (
        arguments.length !== 1 ||
        typeof reason !== "string" ||
        !reason.trim()
      )
        throw new TypeError("ng() requires one non-empty reason");
      if (attempt.action !== "validate" && attempt.action !== "evaluate")
        throw new TypeError("ng() is only available to checks");
      await saveOutcome(db, attempt.id, attempt.action, { ok: false, reason });
    },
  });
}

export function assertJson(
  value: unknown,
  label = "Value",
): asserts value is JsonValue {
  const ancestors = new Set<object>();
  function visit(item: unknown): void {
    if (item === null || typeof item === "string" || typeof item === "boolean")
      return;
    if (typeof item === "number" && Number.isFinite(item)) return;
    if (typeof item !== "object" || item === null)
      throw new TypeError(`${label} must be a JSON value`);
    if (ancestors.has(item))
      throw new TypeError(`${label} must not contain cycles`);
    if (
      !Array.isArray(item) &&
      Object.getPrototypeOf(item) !== Object.prototype &&
      Object.getPrototypeOf(item) !== null
    ) {
      throw new TypeError(`${label} must contain only plain JSON objects`);
    }
    if (Object.getOwnPropertySymbols(item).length)
      throw new TypeError(`${label} must not contain symbol keys`);
    ancestors.add(item);
    if (Array.isArray(item)) {
      for (let index = 0; index < item.length; index++) visit(item[index]);
    } else {
      for (const entry of Object.values(item)) visit(entry);
    }
    ancestors.delete(item);
  }
  visit(value);
}

export function recordError(
  error: unknown,
  source: ErrorSource,
  extra: Pick<AttemptError, "fatal"> = {},
): AttemptError {
  return {
    source,
    name: error instanceof Error ? error.name : "Error",
    message: error instanceof Error ? error.message : String(error),
    ...(error instanceof Error && error.stack ? { stack: error.stack } : {}),
    ...extra,
  };
}
