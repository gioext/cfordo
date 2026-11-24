import { assertJson } from "./validation.ts";
import { getGoal, listAttempts, updateGoal } from "../db/store.ts";
import type {
  JsonValue,
  OrdoEnv,
  Plan,
  RegisteredStep,
  Playbook,
} from "../types.ts";
import { dispatchStep } from "./engine.ts";
import { getGoalStatus } from "./goal.ts";
import { completedResult, stepProgress } from "./progress.ts";

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
  const pending = new Map<
    string,
    { progress: ReturnType<typeof stepProgress>; instruction?: JsonValue }
  >();
  function inspect(name: string, instruction?: JsonValue) {
    const progress = stepProgress(
      history.filter((a) => a.stepName === name),
      maxIterations,
    );
    if (progress.status === "completed") return;
    if (pending.has(name))
      throw new Error(`Duplicate step name in parallel group: ${name}`);
    pending.set(name, { progress, instruction });
    throw waiting;
  }

  try {
    if (typeof plan === "function") {
      await plan({
        input: structuredClone(goal.input),
        env,
        async result<T>(name: string) {
          return completedResult<T>(history, name, goalId, maxIterations);
        },
        async step(
          first: string | RegisteredStep<Env>,
          second: unknown,
          third?: unknown,
        ) {
          const named = typeof first === "string";
          const definition = named ? (second as RegisteredStep<Env>) : first;
          const name = named ? first : definition.name;
          if (!name.trim()) throw new Error("Step name must be non-empty");
          if (definitions.get(definition.name) !== definition)
            throw new Error("Use the step definition returned by ordo.step()");
          const params = named ? third : second;
          assertJson(params, "Step input");
          const instruction: Record<string, JsonValue> = {};
          if (name !== definition.name) instruction.name = definition.name;
          if (JSON.stringify(params) !== JSON.stringify(goal.input))
            instruction.params = structuredClone(params);
          inspect(name, Object.keys(instruction).length ? instruction : undefined);
        },
        async parallel(steps) {
          const results = await Promise.allSettled(steps);
          for (const result of results)
            if (result.status === "rejected" && result.reason !== waiting)
              throw result.reason;
          for (const result of results) {
            if (result.status === "rejected") throw result.reason;
          }
        },
      });
    } else {
      for (const group of plan)
        await Promise.all(group.map(async (def) => inspect(def.name)));
    }
  } catch (error) {
    if (error !== waiting) {
      console.error("Workflow plan failed", { goalId, error });
      await updateGoal(env.DB, goalId, "failed", expiresIn);
      return;
    }
  }
  if (
    [...pending.values()].some(({ progress }) => progress.status === "failed")
  ) {
    await updateGoal(env.DB, goalId, "failed", expiresIn);
    return;
  }
  if (pending.size) {
    const deliveries = await Promise.allSettled(
      [...pending].map(async ([name, { progress, instruction }]) => {
        if (progress.dispatch)
          await dispatchStep(
            env,
            goalId,
            name,
            instruction,
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
