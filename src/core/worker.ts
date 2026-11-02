import { Qu } from "cfqu";
import { initOrdo } from "../db/init.ts";
import {
  claimAttempt,
  getAttempt,
  getGoal,
  updateAttempt,
  type AttemptPatch,
} from "../db/store.ts";
import {
  completionType,
  type Attempt,
  type Intent,
  type OrdoBindings,
  type QueueBatch,
  type QueueHandler,
  type WorkerDefinition,
  type WorkerExecutor,
} from "../types.ts";
import { getGoalStatus } from "./goal.ts";
import {
  assertJson,
  createContext,
  recordError,
  runCheck,
} from "./validation.ts";

function isIntent(value: unknown): value is Intent {
  if (!value || typeof value !== "object") return false;
  const item = value as Record<string, unknown>;
  if (item.protocol !== "cfordo/1") return false;
  if (
    ![item.goalId, item.attemptId].every(
      (id) => Number.isSafeInteger(id) && Number(id) > 0,
    )
  )
    return false;
  if (
    ![item.stepName, item.instanceId].every(
      (name) => typeof name === "string" && name.length > 0,
    )
  )
    return false;
  if (item.feedback !== undefined) {
    if (!item.feedback || typeof item.feedback !== "object") return false;
    const feedback = item.feedback as Record<string, unknown>;
    if (
      typeof feedback.source !== "string" ||
      !["validate", "evaluate"].includes(feedback.source) ||
      typeof feedback.reason !== "string"
    )
      return false;
  }
  if (item.resume !== undefined) {
    if (!item.resume || typeof item.resume !== "object") return false;
    const resume = item.resume as Record<string, unknown>;
    if (
      typeof resume.phase !== "string" ||
      !["validate", "evaluate"].includes(resume.phase) ||
      !Number.isSafeInteger(resume.attemptId) ||
      Number(resume.attemptId) <= 0
    )
      return false;
  }
  return true;
}

function workerResultSaved(
  attempt: Attempt,
  definition: WorkerDefinition | undefined,
): boolean {
  if (attempt.error || attempt.validation?.ok === false) return true;
  return (
    !!definition &&
    attempt.output !== undefined &&
    (!definition.validate || attempt.validation?.ok === true)
  );
}

function matches(attempt: Attempt, intent: Intent): boolean {
  return (
    attempt.goalId === intent.goalId && attempt.stepName === intent.stepName
  );
}

export async function notifyCompletion(
  intent: Intent,
  options: OrdoBindings,
): Promise<void> {
  const attempt = await getAttempt(options.db, intent.attemptId);
  const goal = await getGoal(options.db, intent.goalId);
  if (
    attempt.status === "completed" ||
    attempt.status === "failed" ||
    goal.status === "completed" ||
    goal.status === "failed"
  )
    return;
  const binding = options.workflow;
  try {
    const instance = await binding.get(intent.instanceId);
    await instance.sendEvent({
      type: completionType(intent.attemptId),
      payload: { attemptId: intent.attemptId },
    });
  } catch (error) {
    // A duplicate notification may race with the Engine completing the Goal.
    const current = await getAttempt(options.db, intent.attemptId);
    const currentGoal = await getGoal(options.db, intent.goalId);
    if (
      current.status === "completed" ||
      current.status === "failed" ||
      currentGoal.status === "completed" ||
      currentGoal.status === "failed"
    )
      return;
    throw error;
  }
}

async function runWorker(
  definition: WorkerDefinition,
  intent: Intent,
  options: OrdoBindings,
): Promise<AttemptPatch> {
  const goal = await getGoal(options.db, intent.goalId);
  const details = {
    goalId: intent.goalId,
    stepName: intent.stepName,
    attemptId: intent.attemptId,
    ...(intent.feedback ? { feedback: intent.feedback } : {}),
  };
  const result: AttemptPatch = { error: null, validation: null };
  let value: unknown;
  if (intent.resume) {
    const previous = await getAttempt(options.db, intent.resume.attemptId);
    if (
      !matches(previous, intent) ||
      previous.id >= intent.attemptId ||
      previous.error?.source !== intent.resume.phase
    ) {
      return {
        error: recordError("Invalid retry source", "configuration", {
          fatal: true,
        }),
      };
    }
    if (intent.resume.phase !== "validate") {
      return {
        error: recordError(
          "Evaluation retries belong to the Engine",
          "configuration",
          { fatal: true },
        ),
      };
    }
    value = previous.output;
    result.output = previous.output;
    assertJson(value, "Saved retry input");
  } else {
    try {
      value = await definition.run(createContext(details, goal.input));
      assertJson(value, "Worker return value");
    } catch (error) {
      return { error: recordError(error, "run") };
    }
  }

  result.output = value;
  if (definition.validate) {
    await updateAttempt(options.db, intent.attemptId, { status: "validating" });
    try {
      result.validation = await runCheck(
        definition.validate,
        createContext(details, goal.input, result.output),
      );
    } catch (error) {
      result.error = recordError(error, "validate");
    }
  }
  return result;
}

export function createWorker(
  definition: WorkerDefinition | undefined,
): WorkerExecutor {
  return async (intent, options) => {
    const attempt = await getAttempt(options.db, intent.attemptId);
    if (!matches(attempt, intent))
      throw new Error("Intent does not match its Attempt");
    if (attempt.status === "completed" || attempt.status === "failed") return;

    // A lost sendEvent response or Queue redelivery must not re-run business code.
    if (workerResultSaved(attempt, definition)) {
      await notifyCompletion(intent, options);
      return;
    }
    if (getGoalStatus(await getGoal(options.db, intent.goalId)) !== "running")
      return;
    if (!(await claimAttempt(options.db, intent.attemptId))) {
      const current = await getAttempt(options.db, intent.attemptId);
      if (workerResultSaved(current, definition))
        await notifyCompletion(intent, options);
      return;
    }

    const result = definition
      ? await runWorker(definition, intent, options)
      : {
          error: recordError(
            `Step not registered: ${intent.stepName}`,
            "configuration",
            { fatal: true },
          ),
        };
    // Storage errors escape to Queue retry. No completion is sent on failed save.
    const saved = await updateAttempt(options.db, intent.attemptId, result);
    if (saved) await notifyCompletion(intent, options);
  };
}

export function createQueueConsumer<Env>(
  workers: ReadonlyMap<string, WorkerExecutor>,
  resolveOptions: () => Promise<OrdoBindings>,
): QueueHandler<Env> {
  const qu = new Qu<Env>();
  const unknownWorker = createWorker(undefined);
  const receive = async (batch: QueueBatch): Promise<void> => {
    // Each invocation keeps its own bindings; concurrent events cannot replace
    // another invocation's database or notification destination.
    const options = await resolveOptions();
    await initOrdo(options.db);
    await Promise.all(
      batch.messages.map(async (message) => {
        try {
          if (!isIntent(message.body)) throw new Error("Invalid cfordo Intent");
          const execute = workers.get(message.body.stepName) ?? unknownWorker;
          await execute(message.body, options);
          message.ack();
        } catch {
          message.retry();
        }
      }),
    );
  };
  // cfqu forwards the original Cloudflare values. The cast keeps its ambient
  // Cloudflare type dependency out of cfordo's public declarations.
  const dispatch = qu.queue as unknown as QueueHandler<Env>;
  return (batch, env, ctx) => {
    qu.on(batch.queue, receive);
    return dispatch(batch, env, ctx);
  };
}
