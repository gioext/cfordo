import { stepProgress } from "./progress.ts";
import {
  ensureIteration,
  finishDispatch,
  getGoal,
  listAttempts,
  listIterations,
  reserveDispatch,
  updateGoal,
} from "../db/store.ts";
import type { OrdoEnv, RegisteredStep } from "../types.ts";
import { getGoalStatus } from "./goal.ts";

export async function executeStep(
  env: OrdoEnv,
  goalId: number,
  definition: RegisteredStep,
): Promise<void> {
  if (getGoalStatus(await getGoal(env.DB, goalId)) !== "running") return;
  const history = await listAttempts(env.DB, goalId, definition.name);
  let rounds = await listIterations(env.DB, goalId, definition.name);
  const progress = stepProgress(history, rounds, definition);
  if (progress.status === "failed") {
    await updateGoal(env.DB, goalId, "failed", progress.error ?? undefined);
    return;
  }
  if (progress.status === "completed") return;
  let round = rounds.at(-1);
  if (!round || round.status === "completed") {
    await ensureIteration(
      env.DB,
      goalId,
      definition.name,
      (round?.iteration ?? 0) + 1,
    );
    rounds = await listIterations(env.DB, goalId, definition.name);
    round = rounds.at(-1);
  }
  if (!round) return;
  const token = crypto.randomUUID();
  if (!(await reserveDispatch(env.DB, round.id, token))) return;
  try {
    await env.QUEUE.send({
      protocol: "cfordo/3",
      iterationId: round.id,
      dispatchToken: token,
    });
    await finishDispatch(env.DB, round.id, token, true);
  } catch (error) {
    await finishDispatch(env.DB, round.id, token, false);
    throw error;
  }
}
