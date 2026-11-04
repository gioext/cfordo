import { initOrdo } from "../db/init.ts";
import {
  attachWorkflow,
  getGoal,
  insertGoal,
  listGoals,
  listAttempts,
  listAllAttempts,
} from "../db/store.ts";
import type {
  EffectiveGoalStatus,
  Goal,
  OrdoBindings,
  RegisteredStep,
  Attempt,
  ErrorInfo,
  GoalSummary,
  GoalDetail,
  StepResult,
  ExecutionDetail,
} from "../types.ts";
import { assertJson } from "./validation.ts";
import { budgetExhausted, nextAction } from "./progress.ts";

export function getGoalStatus(
  goal: Goal,
  now = Date.now(),
): EffectiveGoalStatus {
  return (goal.status === "ready" || goal.status === "running") &&
    now >= goal.expiresAt
    ? "expired"
    : goal.status;
}

export class GoalStartError extends Error {
  readonly goalId: number;
  constructor(goalId: number, cause: unknown) {
    super(
      "Workflow creation could not be confirmed; inspect this Goal before starting another",
      { cause },
    );
    this.goalId = goalId;
  }
}
export class GoalReadError extends Error {
  constructor(cause: unknown) {
    super("Workflow status is temporarily unavailable", { cause });
  }
}

export async function startGoal(
  bindings: OrdoBindings,
  input: unknown,
  expiresIn: number,
): Promise<number> {
  assertJson(input, "Goal input");
  await initOrdo(bindings.db);
  const goal = await insertGoal(bindings.db, input, expiresIn);
  try {
    const instance = await bindings.workflow.create({
      params: { goalId: goal.id },
    });
    await attachWorkflow(bindings.db, goal.id, instance.id);
  } catch (cause) {
    // A rejected request may still have created an instance. Its first step
    // attaches the same Goal, so a lost response does not discard that work.
    throw new GoalStartError(goal.id, cause);
  }
  return goal.id;
}

function errorInfo(
  error: { name: string; message: string } | null,
): ErrorInfo | null {
  return error ? { code: error.name, message: error.message } : null;
}

function execution(attempt: Attempt): ExecutionDetail {
  return {
    attemptId: attempt.id,
    action: attempt.action!,
    sourceRunId: attempt.sourceRunId,
    status: attempt.status,
    output: attempt.output ?? null,
    verdict: attempt.validation ?? attempt.evaluation,
    error: errorInfo(attempt.error),
    createdAt: attempt.createdAt,
    finishedAt: attempt.finishedAt,
  };
}

function stepResult(
  name: string,
  history: Attempt[],
  definition: RegisteredStep | undefined,
  goalStatus: EffectiveGoalStatus,
  expiresAt: number,
): StepResult {
  const last = history.at(-1);
  const run = history
    .slice()
    .reverse()
    .find((item) => item.action === "run");
  // Only checks of this run belong beside its output, including a retry of a check.
  const checks = run
    ? history.filter((item) => item.sourceRunId === run.id)
    : [];
  const validation = checks
    .slice()
    .reverse()
    .find((item) => item.action === "validate");
  const evaluation = checks
    .slice()
    .reverse()
    .find((item) => item.action === "evaluate");
  const exhausted = budgetExhausted(history);
  let status: EffectiveGoalStatus = "ready";
  let action = last?.action ?? null;
  let error = errorInfo(last?.error ?? null);
  if (last) {
    if (exhausted) {
      status = "failed";
      const verdict = last.validation ?? last.evaluation;
      error ??=
        verdict?.ok === false
          ? { code: "CheckRejected", message: verdict.reason }
          : null;
    } else if (last.status === "completed") {
      const next = definition ? nextAction(last, definition) : undefined;
      status = next && goalStatus !== "completed" ? "running" : "completed";
      action = status === "completed" ? null : next!.action;
    } else {
      status = "running";
    }
    if (
      status === "running" &&
      (goalStatus === "expired" || goalStatus === "failed")
    ) {
      status = goalStatus;
    }
  }
  if (
    goalStatus === "expired" &&
    last?.finishedAt !== null &&
    last?.finishedAt !== undefined &&
    last.finishedAt >= expiresAt
  )
    status = "expired";
  if (status === "failed" || status === "expired") action = null;
  return {
    stepName: name,
    status,
    action,
    output: run?.output ?? null,
    validation: validation?.validation ?? null,
    evaluation: evaluation?.evaluation ?? null,
    error,
    createdAt: history[0]?.createdAt ?? null,
    // Expiration or another parallel step failing is not an observed finish of this step.
    finishedAt:
      status === "completed" || (status === "failed" && exhausted)
        ? (last?.finishedAt ?? null)
        : null,
  };
}

async function readState(bindings: OrdoBindings, initial: Goal) {
  let goal = initial;
  let status = getGoalStatus(goal);
  let error = errorInfo(goal.error);
  if ((status === "ready" || status === "running") && goal.instanceId) {
    let platform;
    try {
      platform = await (await bindings.workflow.get(goal.instanceId)).status();
    } catch (cause) {
      throw new GoalReadError(cause);
    }
    if (["complete", "errored", "terminated"].includes(platform.status)) {
      // Results may have been persisted while the platform request was in flight.
      goal = await getGoal(bindings.db, goal.id);
      status = getGoalStatus(goal);
      error = errorInfo(goal.error);
      if (status === "ready" || status === "running") {
        status = "failed";
        error = errorInfo(platform.error ?? null) ?? {
          code: "WorkflowStopped",
          message: `Workflow ${platform.status} before the Goal finished`,
        };
      }
    }
  }
  return { goal, status, error };
}

function summary(
  goal: Goal,
  status: EffectiveGoalStatus,
  error: ErrorInfo | null,
  definitions: readonly RegisteredStep[],
  history: Attempt[],
): GoalSummary {
  const byStep = new Map<string, Attempt[]>();
  for (const item of history) {
    const group = byStep.get(item.stepName) ?? [];
    group.push(item);
    byStep.set(item.stepName, group);
  }
  // Include registered steps that have not started and persisted steps from an older definition.
  const names = new Set([
    ...definitions.map((item) => item.name),
    ...byStep.keys(),
  ]);
  const results = [...names].map((name) =>
    stepResult(
      name,
      byStep.get(name) ?? [],
      definitions.find((item) => item.name === name),
      status,
      goal.expiresAt,
    ),
  );
  return {
    goalId: goal.id,
    input: goal.input,
    status,
    createdAt: goal.createdAt,
    expiresAt: goal.expiresAt,
    finishedAt: goal.finishedAt,
    error:
      error ??
      (status === "failed"
        ? (results.find((item) =>
            budgetExhausted(byStep.get(item.stepName) ?? []),
          )?.error ?? null)
        : null),
    results,
  };
}

export async function readGoal(
  bindings: OrdoBindings,
  definitions: readonly RegisteredStep[],
  id: number,
): Promise<GoalDetail> {
  await initOrdo(bindings.db);
  const { goal, status, error } = await readState(
    bindings,
    await getGoal(bindings.db, id),
  );
  const history = await listAttempts(bindings.db, id);
  const result = summary(goal, status, error, definitions, history);
  return {
    ...result,
    results: result.results.map((item) => ({
      ...item,
      executions: history
        .filter((row) => row.stepName === item.stepName)
        .map(execution),
    })),
  };
}

export async function readGoals(
  bindings: OrdoBindings,
  definitions: readonly RegisteredStep[],
): Promise<GoalSummary[]> {
  await initOrdo(bindings.db);
  const goals = await listGoals(bindings.db);
  const states = await Promise.all(
    goals.map((goal) => readState(bindings, goal)),
  );
  const history = await listAllAttempts(bindings.db);
  const byGoal = new Map<number, Attempt[]>();
  for (const item of history) {
    const group = byGoal.get(item.goalId) ?? [];
    group.push(item);
    byGoal.set(item.goalId, group);
  }
  return states.map(({ goal, status, error }) =>
    summary(goal, status, error, definitions, byGoal.get(goal.id) ?? []),
  );
}
