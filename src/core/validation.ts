import type { AttemptError, ErrorSource, JsonValue } from "../types.ts";

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

export function recordError(error: unknown, source: ErrorSource): AttemptError {
  return {
    source,
    name: error instanceof Error ? error.name : "Error",
    message: error instanceof Error ? error.message : String(error),
    ...(error instanceof Error && error.stack ? { stack: error.stack } : {}),
  };
}
