import { initOrdo } from "../db/init.ts";
import { getGoal, insertGoal, listGoals, listAttempts } from "../db/store.ts";
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
} from "../types.ts";
import { assertJson } from "./validation.ts";
import { feedback, stepProgress, verdict } from "./progress.ts";

export function getGoalStatus(
  goal: Goal,
  expiresIn: number,
  now = Date.now(),
): EffectiveGoalStatus {
  return (goal.status === "ready" || goal.status === "running") &&
    now >= goal.createdAt + expiresIn
    ? "expired"
    : goal.status;
}
export async function startGoal(
  db: DatabaseBinding,
  input: unknown,
): Promise<number> {
  assertJson(input, "Goal input");
  await initOrdo(db);
  return (await insertGoal(db, input)).id;
}
function errorInfo(
  error: { name: string; message: string } | null,
): ErrorInfo | null {
  return error ? { code: error.name, message: error.message } : null;
}
function execution(
  item: Attempt,
  history: readonly Attempt[],
): ExecutionDetail {
  return {
    attemptId: item.id,
    iteration: feedback(history.filter((a) => a.id < item.deliveryId))
      .iteration,
    action: item.action!,
    sourceRunId: item.action === "run" ? null : item.runId,
    status: item.status!,
    output: item.action === "run" ? (item.output ?? null) : null,
    verdict: verdict(item),
    error: errorInfo(item.error),
    createdAt: item.createdAt,
    finishedAt: item.finishedAt,
  };
}
function stepResult(
  name: string,
  history: Attempt[],
  definition: RegisteredStep | undefined,
  goalStatus: EffectiveGoalStatus,
  maxIterations: number,
): StepResult {
  const active = goalStatus === "ready" || goalStatus === "running";
  // Historical outcomes do not reinterpret a failed Goal using today's improvement limit.
  const progress = stepProgress(
    history,
    definition,
    active ? maxIterations : Infinity,
  );
  const run = progress.execution.find((item) => item.action === "run");
  const validation = progress.execution.find(
    (item) => item.action === "validate",
  );
  const evaluation = progress.execution.find(
    (item) => item.action === "evaluate",
  );
  let status: EffectiveGoalStatus = progress.status;
  let action = progress.action;
  let error = errorInfo(progress.last?.error ?? null);
  let finishedAt = progress.finishedAt;
  if (progress.rejected && (status === "failed" || goalStatus === "failed")) {
    status = "failed";
    error = { code: "CheckRejected", message: progress.rejected.reason };
    finishedAt = progress.last!.finishedAt;
  }
  if (
    status === "running" &&
    (goalStatus === "failed" || goalStatus === "expired")
  )
    status = goalStatus;
  if (!active || status === "failed") action = null;
  return {
    stepName: name,
    status,
    action,
    output: run?.output ?? null,
    validation: verdict(validation),
    evaluation: verdict(evaluation),
    error,
    createdAt: history.find((item) => item.action !== null)?.createdAt ?? null,
    finishedAt,
  };
}
export async function readResult<T>(
  db: DatabaseBinding,
  goalId: number,
  definition: RegisteredStep,
  maxIterations: number,
  expiresIn: number,
): Promise<T> {
  const goal = await getGoal(db, goalId);
  const history = await listAttempts(db, goalId);
  const result = stepResult(
    definition.name,
    history.filter((a) => a.stepName === definition.name),
    definition,
    getGoalStatus(goal, expiresIn),
    maxIterations,
  );
  if (result.status !== "completed")
    throw new Error(
      `Step ${definition.name} has no completed result in Goal ${goalId}`,
    );
  return result.output as T;
}
function summary(
  goal: Goal,
  definitions: readonly RegisteredStep[],
  history: Attempt[],
  maxIterations: number,
  expiresIn: number,
): GoalSummary {
  const status = getGoalStatus(goal, expiresIn);
  const names = new Set([
    ...definitions.map((item) => item.name),
    ...history.map((item) => item.stepName),
  ]);
  const results = [...names].map((name) =>
    stepResult(
      name,
      history.filter((a) => a.stepName === name),
      definitions.find((item) => item.name === name),
      status,
      maxIterations,
    ),
  );
  // Every cause comes from its execution row; no representative error is copied onto a Goal.
  const causes = results
    .filter((item) => item.error)
    .map((item) => `${item.stepName}: ${item.error!.message}`);
  const error =
    status === "expired"
      ? { code: "GoalExpired", message: "Goal expired" }
      : status === "failed" && causes.length
        ? { code: "GoalFailed", message: causes.join("; ") }
        : null;
  return {
    goalId: goal.id,
    input: goal.input,
    status,
    createdAt: goal.createdAt,
    expiresAt: goal.createdAt + expiresIn,
    finishedAt: goal.finishedAt,
    error,
    results,
  };
}
export async function readGoal(
  db: DatabaseBinding,
  definitions: readonly RegisteredStep[],
  id: number,
  maxIterations: number,
  expiresIn: number,
): Promise<GoalDetail> {
  await initOrdo(db);
  const goal = await getGoal(db, id);
  const history = await listAttempts(db, id);
  const result = summary(goal, definitions, history, maxIterations, expiresIn);
  return {
    ...result,
    results: result.results.map((item) => {
      const stepHistory = history.filter((a) => a.stepName === item.stepName);
      return {
        ...item,
        executions: stepHistory
          .filter((a) => a.action !== null)
          .map((a) => execution(a, stepHistory)),
      };
    }),
  };
}
export async function readGoals(
  db: DatabaseBinding,
  definitions: readonly RegisteredStep[],
  maxIterations: number,
  expiresIn: number,
): Promise<GoalSummary[]> {
  await initOrdo(db);
  const goals = await listGoals(db);
  const history = await listAttempts(db);
  return goals.map((goal) =>
    summary(
      goal,
      definitions,
      history.filter((a) => a.goalId === goal.id),
      maxIterations,
      expiresIn,
    ),
  );
}
