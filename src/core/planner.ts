import {
  ensureIteration,
  getGoal,
  listIterations,
  updateGoal,
} from "../db/store.ts";
import type { OrdoEnv, Playbook } from "../types.ts";
import { dispatchIteration, readResults } from "./engine.ts";
import { getGoalStatus } from "./goal.ts";
import { stepProgress } from "./progress.ts";

export async function runPlanner<Env extends OrdoEnv>(
  env: Env,
  goalId: number,
  playbook: Playbook<Env>,
): Promise<void> {
  const goal = await getGoal(env.DB, goalId);
  const status = getGoalStatus(goal);
  if (status !== "ready" && status !== "running") return;
  if (status === "ready") await updateGoal(env.DB, goalId, "running");
  const { history, rounds, results } = await readResults(env.DB, goalId);
  for (const group of playbook) {
    const steps = group.map((definition) => ({
      definition,
      rounds: rounds.filter((r) => r.stepName === definition.name),
      progress: stepProgress(
        history.filter((a) => a.stepName === definition.name),
        rounds.filter((r) => r.stepName === definition.name),
        results,
        definition,
      ),
    }));
    const failed = steps.find((s) => s.progress.status === "failed");
    if (failed) {
      await updateGoal(
        env.DB,
        goalId,
        "failed",
        failed.progress.error ?? undefined,
      );
      return;
    }
    if (steps.every((s) => s.progress.status === "completed")) continue;
    const dispatched = await Promise.allSettled(
      steps
        .filter((s) => s.progress.status !== "completed")
        .map(async (s) => {
          let round = s.rounds.at(-1);
          if (!round || s.progress.result) {
            const number = (round?.iteration ?? 0) + 1;
            await ensureIteration(env.DB, goalId, s.definition.name, number);
            round = (
              await listIterations(env.DB, goalId, s.definition.name)
            ).find((r) => r.iteration === number);
          }
          if (round) await dispatchIteration(env, round);
        }),
    );
    const failure = dispatched.find((r) => r.status === "rejected");
    if (failure?.status === "rejected") throw failure.reason;
    return;
  }
  await updateGoal(env.DB, goalId, "completed");
}
