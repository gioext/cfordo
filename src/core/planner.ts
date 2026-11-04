import { getGoal, updateGoal } from "../db/store.ts";
import { NO_WORKFLOW_RETRIES, type Playbook, type Runtime } from "../types.ts";
import { executeStep, Stopped } from "./engine.ts";
import { getGoalStatus } from "./goal.ts";

export async function runPlanner(
  runtime: Runtime,
  goalId: number,
  playbook: Playbook,
): Promise<void> {
  await runtime.step.do(
    `ordo:start:${goalId}`,
    NO_WORKFLOW_RETRIES,
    async () => {
      await updateGoal(runtime.db, goalId, "running");
    },
  );
  let position = 0;
  try {
    for (const group of playbook) {
      const offset = position;
      await Promise.all(
        group.map((definition, index) =>
          executeStep(runtime, goalId, definition, offset + index),
        ),
      );
      position += group.length;
    }
  } catch (error) {
    if (
      error instanceof Stopped &&
      getGoalStatus(await getGoal(runtime.db, goalId)) !== "running"
    )
      return;
    throw error;
  }
  await runtime.step.do(
    `ordo:finish:${goalId}`,
    NO_WORKFLOW_RETRIES,
    async () => {
      await updateGoal(runtime.db, goalId, "completed");
    },
  );
}
