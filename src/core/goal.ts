import { getGoal, insertGoal } from "../db/store.ts";
import { NO_WORKFLOW_RETRIES, type DatabaseBinding, type EffectiveGoalStatus, type Goal, type WorkflowStepBinding } from "../types.ts";
import { assertJson } from "./validation.ts";

export function getGoalStatus(goal: Goal, now = Date.now()): EffectiveGoalStatus {
  return (goal.status === "ready" || goal.status === "running") && now >= goal.expiresAt ? "expired" : goal.status;
}

export async function createGoal(db: DatabaseBinding, step: WorkflowStepBinding, name: string, input: unknown, expiresIn: number): Promise<Goal> {
  assertJson(input, "Goal input");
  const id = await step.do(name, NO_WORKFLOW_RETRIES, async () => (await insertGoal(db, input, expiresIn)).id);
  return getGoal(db, id);
}
