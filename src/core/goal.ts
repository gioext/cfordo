import { initOrdo } from "../db/init.ts";
import {
  getGoal,
  insertGoal,
  listGoals,
  listAttempts,
  listAllAttempts,
  listIterations,
} from "../db/store.ts";
import type {
  EffectiveGoalStatus,
  Goal,
  DatabaseBinding,
  RegisteredStep,
  Attempt,
  ErrorInfo,
  GoalSummary,
  GoalDetail,
  StepResult,
  ExecutionDetail,
  Iteration,
} from "../types.ts";
import { assertJson } from "./validation.ts";
import { stepProgress } from "./progress.ts";

export function getGoalStatus(
  goal: Goal,
  now = Date.now(),
): EffectiveGoalStatus {
  return (goal.status === "ready" || goal.status === "running") &&
    now >= goal.expiresAt
    ? "expired"
    : goal.status;
}

export async function startGoal(
  db: DatabaseBinding,
  input: unknown,
  expiresIn: number,
): Promise<number> {
  assertJson(input, "Goal input");
  await initOrdo(db);
  return (await insertGoal(db, input, expiresIn)).id;
}

function errorInfo(
  error: { name: string; message: string } | null,
): ErrorInfo | null {
  return error ? { code: error.name, message: error.message } : null;
}

function execution(attempt: Attempt): ExecutionDetail {
  return {
    attemptId: attempt.id,
    ...(attempt.iteration !== null
      ? { iteration: attempt.iteration, delivery: attempt.delivery! }
      : {}),
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
  rounds: Iteration[],
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
  const progress = stepProgress(history, rounds, definition);
  let { status, action } = progress as {
    status: EffectiveGoalStatus;
    action: StepResult["action"];
  };
  let error = errorInfo(progress.error);
  if (
    status === "running" &&
    (goalStatus === "failed" || goalStatus === "expired")
  ) {
    status = goalStatus;
    const verdict = last?.validation ?? last?.evaluation;
    if (!error && verdict?.ok === false)
      error = { code: "CheckRejected", message: verdict.reason };
  }
  if (
    goalStatus === "expired" &&
    (progress.finishedAt ?? last?.finishedAt) !== null &&
    (progress.finishedAt ?? last?.finishedAt) !== undefined &&
    (progress.finishedAt ?? last!.finishedAt!) >= expiresAt
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
    finishedAt: progress.finishedAt,
  };
}

export async function readResult<T>(
  db: DatabaseBinding,
  goalId: number,
  definition: RegisteredStep,
): Promise<T> {
  const goal = await getGoal(db, goalId);
  const history = await listAttempts(db, goalId, definition.name);
  const rounds = await listIterations(db, goalId, definition.name);
  const result = stepResult(
    definition.name,
    history,
    rounds,
    definition,
    getGoalStatus(goal),
    goal.expiresAt,
  );
  if (result.status !== "completed")
    throw new Error(
      `Step ${definition.name} has no completed result in Goal ${goalId}`,
    );
  return result.output as T;
}

function summary(
  goal: Goal,
  status: EffectiveGoalStatus,
  error: ErrorInfo | null,
  definitions: readonly RegisteredStep[],
  history: Attempt[],
  rounds: Iteration[],
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
      rounds.filter((round) => round.stepName === name),
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
        ? (results.find((item) => item.status === "failed" && item.error)
            ?.error ?? null)
        : null),
    results,
  };
}

export async function readGoal(
  db: DatabaseBinding,
  definitions: readonly RegisteredStep[],
  id: number,
): Promise<GoalDetail> {
  await initOrdo(db);
  const goal = await getGoal(db, id);
  const status = getGoalStatus(goal);
  const error = errorInfo(goal.error);
  const history = await listAttempts(db, id);
  const rounds = await listIterations(db, id);
  const result = summary(goal, status, error, definitions, history, rounds);
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
  db: DatabaseBinding,
  definitions: readonly RegisteredStep[],
): Promise<GoalSummary[]> {
  await initOrdo(db);
  const goals = await listGoals(db);
  const history = await listAllAttempts(db);
  const rounds = await listIterations(db);
  const byGoal = new Map<number, Attempt[]>();
  for (const item of history) {
    const group = byGoal.get(item.goalId) ?? [];
    group.push(item);
    byGoal.set(item.goalId, group);
  }
  return goals.map((goal) =>
    summary(
      goal,
      getGoalStatus(goal),
      errorInfo(goal.error),
      definitions,
      byGoal.get(goal.id) ?? [],
      rounds.filter((round) => round.goalId === goal.id),
    ),
  );
}
