import {
  getGoal,
  listAttempts,
  listIterations,
  updateGoal,
} from "../db/store.ts";
import type { OrdoEnv, Playbook } from "../types.ts";
import { executeStep } from "./engine.ts";
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
  const history = await listAttempts(env.DB, goalId);
  const rounds = await listIterations(env.DB, goalId);
  for (const group of playbook) {
    const steps = group.map((definition) => ({
      definition,
      progress: stepProgress(
        history.filter((a) => a.stepName === definition.name),
        rounds.filter((r) => r.stepName === definition.name),
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
    const results = await Promise.allSettled(
      steps
        .filter((s) => s.progress.status !== "completed")
        .map((s) => executeStep(env, goalId, s.definition)),
    );
    const failure = results.find((r) => r.status === "rejected");
    if (failure?.status === "rejected") throw failure.reason;
    return;
  }
  await updateGoal(env.DB, goalId, "completed");
}
