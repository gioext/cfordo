import {
  finishDispatch,
  listAllAttempts,
  listAttempts,
  listIterationResults,
  listIterations,
  reserveDispatch,
} from "../db/store.ts";
import type { DatabaseBinding, Iteration, OrdoEnv } from "../types.ts";

export async function readResults(db: DatabaseBinding, goalId?: number) {
  // Read final results first so each referenced action exists in the later history read.
  const results = await listIterationResults(db, goalId);
  const rounds = await listIterations(db, goalId);
  const history =
    goalId === undefined
      ? await listAllAttempts(db)
      : await listAttempts(db, goalId);
  return { results, rounds, history };
}

export async function dispatchIteration(
  env: OrdoEnv,
  round: Iteration,
): Promise<void> {
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
