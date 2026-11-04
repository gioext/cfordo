import type { Action, Attempt, RegisteredStep } from "../types.ts";

export function budgetExhausted(attempts: readonly Attempt[]): boolean {
  return (
    attempts.some((a) => a.error?.fatal) ||
    attempts.filter((a) => a.status === "failed").length >= 3 ||
    attempts.filter(
      (a) =>
        a.status === "completed" &&
        a.action === "validate" &&
        a.validation?.ok === false,
    ).length >= 3 ||
    attempts.filter(
      (a) =>
        a.status === "completed" &&
        a.action === "evaluate" &&
        a.evaluation?.ok === false,
    ).length >= 10
  );
}

export function nextAction(
  last: Attempt,
  definition: RegisteredStep,
): { action: Action; sourceRunId: number | null } | undefined {
  if (last.status === "failed") {
    if (!last.action) throw new Error("Legacy action cannot be resumed");
    return { action: last.action, sourceRunId: last.sourceRunId };
  }
  if (last.status !== "completed") throw new Error("Action has not finished");
  if (last.action === "run") {
    if (definition.validate)
      return { action: "validate", sourceRunId: last.id };
    if (definition.evaluate)
      return { action: "evaluate", sourceRunId: last.id };
  } else if (last.action === "validate") {
    if (!last.validation)
      throw new Error("Completed validation has no saved verdict");
    if (!last.validation.ok) return { action: "run", sourceRunId: null };
    if (definition.evaluate)
      return { action: "evaluate", sourceRunId: last.sourceRunId };
  } else if (last.action === "evaluate") {
    if (!last.evaluation)
      throw new Error("Completed evaluation has no saved verdict");
    if (!last.evaluation.ok) return { action: "run", sourceRunId: null };
  } else throw new Error("Legacy action cannot be resumed");
}
