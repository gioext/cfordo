import type {
  Action,
  Attempt,
  AttemptError,
  Iteration,
  IterationResult,
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

/** Select one execution without making scheduling or Goal-termination decisions. */
export function executionResult(
  history: readonly Attempt[],
  round: Iteration | undefined,
  results: readonly IterationResult[],
) {
  // Results are ordered by their INSERT IDs, allocated only at final persistence.
  const result = round
    ? results.find((r) => r.iterationId === round.id)
    : undefined;
  const candidates = round
    ? history.filter((a) => a.iterationId === round.id)
    : history;
  const last = result
    ? candidates.find((a) => a.id === result.attemptId)
    : candidates.at(-1);
  const runId = last?.action === "run" ? last.id : last?.sourceRunId;
  const execution = candidates.filter(
    (a) => a.id === runId || (runId != null && a.sourceRunId === runId),
  );
  return { result, last, execution };
}

export function stepProgress(
  history: readonly Attempt[],
  rounds: readonly Iteration[],
  results: readonly IterationResult[],
  definition: RegisteredStep | undefined,
) {
  const round = rounds.at(-1);
  const { result, last, execution } = executionResult(history, round, results);
  let status: "ready" | "running" | "completed" | "failed" =
    last || round ? "running" : "ready";
  let action: Action | null = last
    ? followingAction(last, definition)
    : round
      ? "run"
      : null;
  let error: AttemptError | null = result?.error ?? last?.error ?? null;
  let finishedAt: number | null = null;
  if (!round) {
    // Historical per-action records remain readable, with their original semantics.
    if (last?.status === "completed" && !action) {
      status = "completed";
      finishedAt = last.finishedAt;
    }
    if (last?.status === "failed") {
      status = "failed";
      action = null;
      finishedAt = last.finishedAt;
    }
  } else if (result?.error) {
    status = "failed";
    action = null;
    finishedAt = result.finishedAt;
  } else if (result) {
    if (!last || last.status !== "completed")
      throw new Error("Final iteration result has no completed action");
    const rejected = improvement(last);
    if (rejected) {
      action = "run";
      error = null;
      if (round.iteration >= MAX_ITERATIONS) {
        status = "failed";
        action = null;
        finishedAt = result.finishedAt;
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
      finishedAt = result.finishedAt;
    }
  }
  return { status, action, error, finishedAt, execution, result };
}
