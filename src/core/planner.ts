import { getGoal, listAttempts, updateGoal } from "../db/store.ts";
import type { OrdoEnv, Playbook } from "../types.ts";
import { dispatchStep } from "./engine.ts";
import { getGoalStatus } from "./goal.ts";
import { stepProgress } from "./progress.ts";

export async function runPlanner<Env extends OrdoEnv>(
  env: Env,
  goalId: number,
  playbook: Playbook<Env>,
  maxIterations: number,
  expiresIn: number,
): Promise<void> {
  const goal = await getGoal(env.DB, goalId);
  if (goal.status !== "ready" && goal.status !== "running") return;
  if (getGoalStatus(goal, expiresIn) === "expired") {
    await updateGoal(env.DB, goalId, "expired", expiresIn);
    return;
  }
  if (goal.status === "ready")
    await updateGoal(env.DB, goalId, "running", expiresIn);
  const history = await listAttempts(env.DB, goalId);
  for (const group of playbook) {
    const steps = group.map((definition) => ({
      definition,
      progress: stepProgress(
        history.filter((a) => a.stepName === definition.name),
        definition,
        maxIterations,
      ),
    }));
    if (steps.some((s) => s.progress.status === "failed")) {
      await updateGoal(env.DB, goalId, "failed", expiresIn);
      return;
    }
    if (steps.every((s) => s.progress.status === "completed")) continue;
    const dispatched = await Promise.allSettled(
      steps
        .filter((s) => s.progress.dispatch)
        .map((s) =>
          dispatchStep(
            env,
            goalId,
            s.definition.name,
            s.progress.delivery,
            s.progress.last,
            s.progress.dispatch === "recover",
            expiresIn,
          ),
        ),
    );
    const failure = dispatched.find((r) => r.status === "rejected");
    if (failure?.status === "rejected") throw failure.reason;
    return;
  }
  await updateGoal(env.DB, goalId, "completed", expiresIn);
}
