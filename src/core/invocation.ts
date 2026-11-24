import type { JsonValue } from "../types.ts";
// Only 0.6.0 deliveries encoded the handler and argument in their name.
export function invocation(stepName: string): {
  name: string;
  params?: JsonValue;
} {
  if (!stepName.startsWith("@plan:")) return { name: stepName };
  const [name, params] = JSON.parse(stepName.slice(6));
  return { name, params };
}
