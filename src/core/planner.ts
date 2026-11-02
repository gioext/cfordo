import { getGoal, listAttempts, updateGoal } from "../db/store.ts";
import {
  NO_WORKFLOW_RETRIES,
  type Attempt,
  type DatabaseBinding,
  type Playbook,
  type RunStatus,
  type Runtime,
} from "../types.ts";
import { executeStep } from "./engine.ts";
import { getGoalStatus } from "./goal.ts";

export function planNextSteps(
  playbook: Playbook,
  attempts: readonly Attempt[],
): number | null {
  const latest = new Map<string, Attempt>();
  for (const attempt of attempts) {
    if ((latest.get(attempt.stepName)?.id ?? 0) < attempt.id)
      latest.set(attempt.stepName, attempt);
  }
  const index = playbook.findIndex((group) =>
    group.some((step) => latest.get(step.name)?.status !== "completed"),
  );
  return index < 0 ? null : index;
}

class Stopped extends Error {
  readonly status: RunStatus;
  constructor(status: RunStatus) {
    super(status);
    this.status = status;
  }
}

export async function failGoal(
  db: DatabaseBinding,
  goalId: number,
): Promise<RunStatus> {
  const status = getGoalStatus(await getGoal(db, goalId));
  if (status === "expired" || status === "completed" || status === "failed")
    return status;
  await updateGoal(db, goalId, "failed");
  return getGoalStatus(await getGoal(db, goalId)) === "expired"
    ? "expired"
    : "failed";
}

export async function runPlanner(
  runtime: Runtime,
  goalId: number,
  playbook: Playbook,
): Promise<RunStatus> {
  await runtime.step.do(
    `ordo:start:${goalId}`,
    NO_WORKFLOW_RETRIES,
    async () => {
      await updateGoal(runtime.db, goalId, "running");
      return null;
    },
  );
  for (let round = 0; ; round++) {
    const plan = await runtime.step.do(
      `ordo:next:${goalId}:${round}`,
      NO_WORKFLOW_RETRIES,
      async () => {
        const status = getGoalStatus(await getGoal(runtime.db, goalId));
        if (
          status === "completed" ||
          status === "failed" ||
          status === "expired"
        )
          return JSON.stringify({ status });
        const index = planNextSteps(
          playbook,
          await listAttempts(runtime.db, goalId),
        );
        if (index === null) {
          await updateGoal(runtime.db, goalId, "completed");
          return JSON.stringify({
            status: getGoalStatus(await getGoal(runtime.db, goalId)),
          });
        }
        return JSON.stringify({ index });
      },
    );
    const next = JSON.parse(plan) as { index?: number; status?: RunStatus };
    if (next.status) return next.status;
    if (next.index === undefined) throw new Error("Planner returned no stage");
    const index = next.index;
    const offset = playbook
      .slice(0, index)
      .reduce((count, group) => count + group.length, 0);
    try {
      await Promise.all(
        playbook[index].map(async (definition, stepIndex) => {
          const status = await executeStep(
            runtime,
            goalId,
            definition,
            offset + stepIndex,
          );
          if (status === "completed") return;
          if (status === "failed") {
            const stopped = await runtime.step.do(
              `ordo:failed:${goalId}:${offset + stepIndex}`,
              NO_WORKFLOW_RETRIES,
              async () => {
                return failGoal(runtime.db, goalId);
              },
            );
            throw new Stopped(stopped === "expired" ? "expired" : "failed");
          }
          throw new Stopped("expired");
        }),
      );
    } catch (error) {
      if (error instanceof Stopped) return error.status;
      throw error;
    }
  }
}
