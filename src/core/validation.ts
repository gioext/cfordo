import type { AttemptError, CheckDecision, CheckFunction, CheckResult, ErrorSource, JsonValue, OrdoContext } from "../types.ts";

// Identity-based decisions prevent arbitrary return objects from being accepted.
// The marker also makes returning a decision as business JSON an explicit error.
const marker = Symbol("check decision");
const contexts = new WeakMap<OrdoContext, WeakMap<object, CheckResult>>();

export function createContext(
  details: Pick<OrdoContext, "goalId" | "stepName" | "attemptId" | "feedback">,
  params: JsonValue,
  result?: JsonValue,
): OrdoContext {
  const decisions = new WeakMap<object, CheckResult>();
  function decision(value: CheckResult): CheckDecision {
    const token = Object.freeze({ [marker]: true });
    decisions.set(token, value);
    return token as unknown as CheckDecision;
  }
  const ctx: OrdoContext = Object.freeze({
    ...details,
    params<T = any>(): T { return structuredClone(params) as T; },
    result<T = any>(): T { return structuredClone(result) as T; },
    ok(): CheckDecision {
      if (arguments.length !== 0) throw new TypeError("ok() does not accept arguments");
      return decision({ ok: true });
    },
    ng(reason: string): CheckDecision {
      if (arguments.length !== 1 || typeof reason !== "string" || !reason.trim()) {
        throw new TypeError("ng() requires one non-empty reason");
      }
      return decision({ ok: false, reason });
    },
  });
  contexts.set(ctx, decisions);
  return ctx;
}

export function assertJson(value: unknown, label = "Value"): asserts value is JsonValue {
  const ancestors = new Set<object>();
  function visit(item: unknown): void {
    if (item === null || typeof item === "string" || typeof item === "boolean") return;
    if (typeof item === "number" && Number.isFinite(item)) return;
    if (typeof item !== "object" || item === null) throw new TypeError(`${label} must be a JSON value`);
    if (ancestors.has(item)) throw new TypeError(`${label} must not contain cycles`);
    if (!Array.isArray(item) && Object.getPrototypeOf(item) !== Object.prototype && Object.getPrototypeOf(item) !== null) {
      throw new TypeError(`${label} must contain only plain JSON objects`);
    }
    if (Object.getOwnPropertySymbols(item).length) throw new TypeError(`${label} must not contain symbol keys`);
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

export async function runCheck(fn: CheckFunction, ctx: OrdoContext): Promise<CheckResult> {
  const decision = await fn(ctx);
  const result = decision && typeof decision === "object" ? contexts.get(ctx)?.get(decision) : undefined;
  if (!result) throw new TypeError("A check must return its context's ok() or ng(reason)");
  return result;
}

export function recordError(error: unknown, source: ErrorSource, extra: Pick<AttemptError, "fatal"> = {}): AttemptError {
  return {
    source,
    name: error instanceof Error ? error.name : "Error",
    message: error instanceof Error ? error.message : String(error),
    ...extra,
  };
}
