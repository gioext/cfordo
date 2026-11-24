import { invocationName } from "./invocation.ts";
import { getGoal, listAttempts, updateGoal } from "../db/store.ts";
import type { OrdoEnv, Plan, RegisteredStep, Playbook } from "../types.ts";
import { dispatchStep } from "./engine.ts";
import { getGoalStatus } from "./goal.ts";
import { stepProgress } from "./progress.ts";

export async function runPlanner<Env extends OrdoEnv>(
  env: Env,
  goalId: number,
  plan: Playbook<Env> | Plan<any, Env>,
  definitions: ReadonlyMap<string, RegisteredStep<Env>>,
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
  const waiting = Symbol();
  const pending = new Map<string, ReturnType<typeof stepProgress>>();
  function inspect(name: string, definition: RegisteredStep<Env>) {
    const progress = stepProgress(
      history.filter((a) => a.stepName === name),
      definition,
      maxIterations,
    );
    if (progress.status === "completed")
      return structuredClone(
        progress.execution.find((a) => a.action === "run")!.output,
      );
    pending.set(name, progress);
    throw waiting;
  }

  try {
    if (typeof plan === "function") {
      await plan({
        input: structuredClone(goal.input),
        env,
        async step(definition, params) {
          if (definitions.get(definition.name) !== definition)
            throw new Error("Use the step definition returned by ordo.step()");
          return inspect(
            invocationName(definition.name, params, goal.input),
            definition,
          ) as any;
        },
        async parallel(steps) {
          const results = await Promise.allSettled(steps);
          for (const result of results)
            if (result.status === "rejected" && result.reason !== waiting)
              throw result.reason;
          return results.map((result) => {
            if (result.status === "rejected") throw result.reason;
            return result.value;
          });
        },
      });
    } else {
      for (const group of plan)
        await Promise.all(group.map(async (def) => inspect(def.name, def)));
    }
  } catch (error) {
    if (error !== waiting) {
      console.error("Workflow plan failed", { goalId, error });
      await updateGoal(env.DB, goalId, "failed", expiresIn);
      return;
    }
  }
  if ([...pending.values()].some((progress) => progress.status === "failed")) {
    await updateGoal(env.DB, goalId, "failed", expiresIn);
    return;
  }
  if (pending.size) {
    const deliveries = await Promise.allSettled(
      [...pending].map(async ([name, progress]) => {
        if (progress.dispatch)
          await dispatchStep(
            env,
            goalId,
            name,
            progress.delivery,
            progress.last,
            progress.dispatch === "recover",
            expiresIn,
          );
      }),
    );
    for (const result of deliveries)
      if (result.status === "rejected") throw result.reason;
    return;
  }
  await updateGoal(env.DB, goalId, "completed", expiresIn);
}
