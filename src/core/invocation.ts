import type { JsonValue } from "../types.ts";
import { assertJson } from "./validation.ts";

// The existing step_name identifies both the handler and its JSON argument.
function canonical(value: JsonValue): JsonValue {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonical(value[key])]),
    );
  return value;
}

export function invocationName(
  name: string,
  params: unknown,
  goalInput: JsonValue,
): string {
  assertJson(params, "Step input");
  if (
    JSON.stringify(canonical(params)) === JSON.stringify(canonical(goalInput))
  )
    return name;
  return "@plan:" + JSON.stringify([name, canonical(params)]);
}

export function invocation(stepName: string): {
  name: string;
  params?: JsonValue;
} {
  if (!stepName.startsWith("@plan:")) return { name: stepName };
  const [name, params] = JSON.parse(stepName.slice(6));
  return { name, params };
}
