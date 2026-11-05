import type {
  Action,
  Attempt,
  AttemptError,
  Iteration,
  RegisteredStep,
  CheckSource,
} from "../types.ts";

export const MAX_ITERATIONS = 10;
export function improvement(
  attempt: Attempt | undefined,
): { source: CheckSource; reason: string } | null {
  if (attempt?.status !== "completed") return null;
  if (attempt.action === "validate" && attempt.validation?.ok === false)
    return { source: "validate", reason: attempt.validation.reason };
  if (attempt.action === "evaluate" && attempt.evaluation?.ok === false)
    return { source: "evaluate", reason: attempt.evaluation.reason };
  return null;
}

function followingAction(
  last: Attempt,
  definition: RegisteredStep | undefined,
): Action | null {
  if (last.status === "failed" || improvement(last)) return "run";
  if (last.status !== "completed") return last.action;
  if (last.action === "run")
    return definition?.validate
      ? "validate"
      : definition?.evaluate
        ? "evaluate"
        : null;
  if (last.action === "validate")
    return definition?.evaluate ? "evaluate" : null;
  return null;
}

export function stepProgress(
  history: readonly Attempt[],
  rounds: readonly Iteration[],
  definition: RegisteredStep | undefined,
) {
  const round = rounds.at(-1);
  const last = round
    ? history
        .filter(
          (a) => a.iterationId === round.id && a.delivery === round.delivery,
        )
        .at(-1)
    : history.at(-1);
  let status: "ready" | "running" | "completed" | "failed" =
    last || round ? "running" : "ready";
  let action: Action | null = last
    ? followingAction(last, definition)
    : round
      ? "run"
      : null;
  let error: AttemptError | null = round?.error ?? last?.error ?? null;
  let finishedAt: number | null = null;
  if (!round) {
    // Historical per-action records remain readable, but have no new scheduling policy.
    if (last?.status === "completed" && !action) {
      status = "completed";
      finishedAt = last.finishedAt;
    }
    if (last?.status === "failed") {
      status = "failed";
      action = null;
      finishedAt = last.finishedAt;
    }
  } else if (round.status === "failed") {
    status = "failed";
    action = null;
    finishedAt = round.finishedAt;
  } else if (round.status === "completed") {
    if (!last || last.status !== "completed")
      throw new Error("Completed iteration has no completed action");
    const rejected = improvement(last);
    if (rejected) {
      action = "run";
      error = null;
      if (round.iteration >= MAX_ITERATIONS) {
        status = "failed";
        action = null;
        finishedAt = round.finishedAt;
        error = {
          source: rejected.source,
          name: "ImprovementLimitExceeded",
          message: `Quality did not pass within ${MAX_ITERATIONS} iterations: ${rejected.reason}`,
        };
      }
    } else {
      const finalAction = definition?.evaluate
        ? "evaluate"
        : definition?.validate
          ? "validate"
          : "run";
      if (last.action !== finalAction)
        throw new Error("Iteration ended before its required checks");
      status = "completed";
      action = null;
      error = null;
      finishedAt = round.finishedAt;
    }
  } else if (round.status === "retrying") {
    action = "run";
  }
  return { status, action, error, finishedAt };
}
