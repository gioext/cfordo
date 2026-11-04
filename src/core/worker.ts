import { initOrdo } from "../db/init.ts";
import {
  claimAttempt,
  failAttempt,
  finishAttempt,
  getAttempt,
  getGoal,
  listAttempts,
} from "../db/store.ts";
import {
  completionType,
  type Attempt,
  type Intent,
  type OrdoBindings,
  type OrdoContext,
  type QueueBatch,
  type QueueHandler,
  type RegisteredStep,
  type WorkerExecutor,
} from "../types.ts";
import { getGoalStatus } from "./goal.ts";
import { createContext, recordError } from "./validation.ts";

function isIntent(value: unknown): value is Intent {
  if (!value || typeof value !== "object") return false;
  const item = value as Record<string, unknown>;
  return (
    item.protocol === "cfordo/2" &&
    Number.isSafeInteger(item.attemptId) &&
    Number(item.attemptId) > 0
  );
}
function terminal(attempt: Attempt): boolean {
  return attempt.status === "completed" || attempt.status === "failed";
}
export async function notifyCompletion(
  id: number,
  bindings: OrdoBindings,
): Promise<void> {
  const attempt = await getAttempt(bindings.db, id);
  if (!terminal(attempt))
    throw new Error(`Action ${id} has no terminal D1 record`);
  const goal = await getGoal(bindings.db, attempt.goalId);
  if (goal.status !== "running") return;
  if (!goal.instanceId) throw new Error("Action has no Workflow instance");
  try {
    const instance = await bindings.workflow.get(goal.instanceId);
    await instance.sendEvent({ type: completionType(id), payload: null });
  } catch (error) {
    if (getGoalStatus(await getGoal(bindings.db, goal.id)) === "running")
      throw error;
  }
}

function feedbackFrom(history: Attempt[]): OrdoContext["feedback"] {
  for (const attempt of history.slice().reverse()) {
    if (attempt.status !== "completed") continue;
    if (attempt.action === "validate" && attempt.validation?.ok === false)
      return { source: "validate", reason: attempt.validation.reason };
    if (attempt.action === "evaluate" && attempt.evaluation?.ok === false)
      return { source: "evaluate", reason: attempt.evaluation.reason };
  }
}

export function createWorker(
  definition: RegisteredStep | undefined,
): WorkerExecutor {
  return async (intent, bindings) => {
    let attempt = await getAttempt(bindings.db, intent.attemptId);
    if (!attempt.action)
      throw new Error(
        "Legacy combined executions cannot use the action consumer",
      );
    if (terminal(attempt)) {
      await notifyCompletion(attempt.id, bindings);
      return;
    }
    const goal = await getGoal(bindings.db, attempt.goalId);
    if (getGoalStatus(goal) !== "running") return;
    if (!(await claimAttempt(bindings.db, attempt.id))) {
      attempt = await getAttempt(bindings.db, attempt.id);
      if (terminal(attempt)) {
        await notifyCompletion(attempt.id, bindings);
        return;
      }
      if (getGoalStatus(await getGoal(bindings.db, goal.id)) !== "running")
        return;
      // Do not guess whether an in-flight execution died, and do not rerun it.
      throw new Error(
        `Action ${attempt.id} is already running; automatic recovery is not supported`,
      );
    }
    const action = attempt.action;
    const handler = (action ? definition?.[action] : undefined) as
      ((ctx: OrdoContext) => Promise<void>) | undefined;
    try {
      if (!handler || definition?.name !== attempt.stepName)
        throw new Error(
          `Handler not registered: ${attempt.stepName}/${action}`,
        );
      let result;
      if (action !== "run") {
        if (attempt.sourceRunId === null)
          throw new Error("Check has no source run");
        const source = await getAttempt(bindings.db, attempt.sourceRunId);
        if (
          source.goalId !== attempt.goalId ||
          source.stepName !== attempt.stepName ||
          source.action !== "run" ||
          source.status !== "completed" ||
          source.output === undefined
        )
          throw new Error("Check source is not a completed run of this step");
        result = source.output;
      }
      const history = (
        await listAttempts(bindings.db, goal.id, attempt.stepName)
      ).filter((a) => a.id < attempt.id);
      const ctx = createContext(
        bindings.db,
        attempt,
        goal.input,
        result,
        feedbackFrom(history),
      );
      // Only completion/exception is observed. Business return values are ignored.
      await handler(ctx);
      await finishAttempt(bindings.db, attempt.id);
    } catch (error) {
      await failAttempt(
        bindings.db,
        attempt.id,
        recordError(error, action ?? "configuration", {
          ...(!handler ? { fatal: true } : {}),
        }),
      );
    }
    await notifyCompletion(attempt.id, bindings);
  };
}

export function createQueueConsumer<Env>(
  workers: ReadonlyMap<string, WorkerExecutor>,
  resolveOptions: () => Promise<OrdoBindings>,
): QueueHandler<Env> {
  const unknownWorker = createWorker(undefined);
  return async (batch: QueueBatch): Promise<void> => {
    const bindings = await resolveOptions();
    await initOrdo(bindings.db);
    await Promise.all(
      batch.messages.map(async (message) => {
        try {
          if (!isIntent(message.body))
            throw new Error("Invalid cfordo action message");
          const attempt = await getAttempt(bindings.db, message.body.attemptId);
          const execute = workers.get(attempt.stepName) ?? unknownWorker;
          await execute(message.body, bindings);
          message.ack();
        } catch (error) {
          console.error("Ordo Queue processing failed", {
            messageId: message.id,
            message: error instanceof Error ? error.message : String(error),
          });
          message.retry();
        }
      }),
    );
  };
}
