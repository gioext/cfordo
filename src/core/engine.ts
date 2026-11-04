import { budgetExhausted, nextAction } from "./progress.ts";
import {
  ensureAttempt,
  failAttempt,
  getAttempt,
  getGoal,
  listAttempts,
  updateGoal,
} from "../db/store.ts";
import {
  completionType,
  NO_WORKFLOW_RETRIES,
  type RegisteredStep,
  type Runtime,
} from "../types.ts";
import { getGoalStatus } from "./goal.ts";
import { recordError } from "./validation.ts";

// This signal only stops a parallel group; the actual outcome lives in D1.
export class Stopped extends Error {}

async function requireRunning(runtime: Runtime, goalId: number): Promise<void> {
  if (getGoalStatus(await getGoal(runtime.db, goalId)) !== "running")
    throw new Stopped();
}

export async function executeAttempt(
  runtime: Runtime,
  id: number,
): Promise<void> {
  let attempt = await getAttempt(runtime.db, id);
  await requireRunning(runtime, attempt.goalId);
  if (attempt.status === "completed" || attempt.status === "failed") return;
  await runtime.step.do(
    `ordo:${attempt.action}:${id}:dispatch`,
    NO_WORKFLOW_RETRIES,
    async () => {
      const current = await getAttempt(runtime.db, id);
      if (current.status !== "ready") return;
      if (
        getGoalStatus(await getGoal(runtime.db, current.goalId)) !== "running"
      )
        return;
      try {
        await runtime.queue.send({ protocol: "cfordo/2", attemptId: id });
      } catch (error) {
        // A lost send response must not invalidate work already claimed by the consumer.
        await failAttempt(
          runtime.db,
          id,
          recordError(error, "dispatch"),
          "ready",
        );
      }
    },
  );
  await requireRunning(runtime, attempt.goalId);
  attempt = await getAttempt(runtime.db, id);
  if (attempt.status !== "completed" && attempt.status !== "failed") {
    await runtime.step.waitForEvent(`ordo:${attempt.action}:${id}:complete`, {
      type: completionType(id),
    });
  }
  await requireRunning(runtime, attempt.goalId);
  attempt = await getAttempt(runtime.db, id);
  if (attempt.status !== "completed" && attempt.status !== "failed")
    throw new Error(`Action ${id} was notified before its D1 record finished`);
}

export async function executeStep(
  runtime: Runtime,
  goalId: number,
  definition: RegisteredStep,
  position: number,
): Promise<void> {
  await requireRunning(runtime, goalId);
  await runtime.step.do(
    `ordo:plan:${goalId}:${position}:root`,
    NO_WORKFLOW_RETRIES,
    async () => {
      await ensureAttempt(
        runtime.db,
        goalId,
        definition.name,
        "run",
        null,
        null,
      );
    },
  );
  for (;;) {
    await requireRunning(runtime, goalId);
    const history = await listAttempts(runtime.db, goalId, definition.name);
    if (budgetExhausted(history)) {
      await updateGoal(runtime.db, goalId, "failed");
      throw new Stopped();
    }
    const last = history.at(-1);
    if (!last) throw new Error(`No execution record for ${definition.name}`);
    if (last.status === "ready" || last.status === "running") {
      await executeAttempt(runtime, last.id);
      continue;
    }
    const next = nextAction(last, definition);
    if (!next) return;
    await runtime.step.do(
      `ordo:plan:${last.id}:next`,
      NO_WORKFLOW_RETRIES,
      async () => {
        await ensureAttempt(
          runtime.db,
          goalId,
          definition.name,
          next.action,
          last.id,
          next.sourceRunId,
        );
      },
    );
  }
}
