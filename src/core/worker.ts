import { SCHEMA_VERSION } from "../db/schema.ts";
import { initOrdo } from "../db/init.ts";
import {
  claimDelivery,
  ExecutionStopped,
  finishAttempt,
  getAttempt,
  getGoal,
  listAttempts,
  failAttempt,
} from "../db/store.ts";
import { DatabaseError } from "../db/query.ts";
import type {
  Action,
  Attempt,
  Intent,
  ErrorSource,
  JsonValue,
  OrdoContext,
  OrdoEnv,
  RegisteredStep,
} from "../types.ts";
import { createContext } from "./context.ts";
import { recordError } from "./validation.ts";
import { feedback, followingAction } from "./progress.ts";

function isIntent(value: unknown): value is Intent {
  if (!value || typeof value !== "object") return false;
  const item = value as Record<string, unknown>;
  return (
    item.protocol === "cfordo/7" &&
    item.schemaVersion === SCHEMA_VERSION &&
    Number.isSafeInteger(item.deliveryId) &&
    Number(item.deliveryId) > 0
  );
}
async function runDelivery<Env extends OrdoEnv>(
  message: Message<Intent>,
  env: Env,
  definitions: ReadonlyMap<string, RegisteredStep<Env>>,
  startedAt: number,
  maxIterations: number,
  expiresIn: number,
): Promise<void> {
  const run = await claimDelivery(
    env.DB,
    message.body.deliveryId,
    startedAt,
    expiresIn,
  );
  if (!run) return;
  let source: ErrorSource = "configuration";
  let current: Attempt = run;
  try {
    const goal = await getGoal(env.DB, run.goalId);
    const definition = definitions.get(run.stepName);
    if (!definition) throw new Error(`Step not registered: ${run.stepName}`);
    const history = await listAttempts(env.DB, goal.id);
    const shared = createContext(
      env,
      goal.id,
      run.stepName,
      goal.input,
      feedback(
        history.filter(
          (a) => a.stepName === run.stepName && a.id < run.deliveryId,
        ),
      ),
      definitions,
      maxIterations,
      expiresIn,
    );
    let output: JsonValue | undefined;
    while (true) {
      const action = current.action!;
      source = action;
      const handler = definition[action] as (
        ctx: OrdoContext<any, any, Action, Env>,
      ) => Promise<void>;
      shared.enter(current, output);
      await handler(shared.context);
      if (!shared.hasOutcome())
        throw new Error("Action ended without saving its result or verdict");
      const saved = await getAttempt(env.DB, current.id);
      if (action === "run") output = saved.output;
      const next = await finishAttempt(
        env.DB,
        current,
        followingAction(saved, definition),
        expiresIn,
      );
      if (!next) return;
      current = next;
    }
  } catch (error) {
    if (error instanceof ExecutionStopped) return;
    if (error instanceof DatabaseError) throw error;
    try {
      await failAttempt(env.DB, current, recordError(error, source), expiresIn);
    } catch (saveError) {
      if (!(saveError instanceof ExecutionStopped)) throw saveError;
    }
  }
}
export async function consumeQueue<Env extends OrdoEnv>(
  batch: MessageBatch<unknown>,
  env: Env,
  definitions: ReadonlyMap<string, RegisteredStep<Env>>,
  startedAt: number,
  maxIterations: number,
  expiresIn: number,
): Promise<void> {
  const messages = batch.messages.filter((message) => {
    if (isIntent(message.body)) return true;
    console.error("Ignoring an unsupported cfordo message or schema version", {
      messageId: message.id,
    });
    message.ack();
    return false;
  });
  if (!messages.length) return;
  await initOrdo(env.DB);
  await Promise.all(
    messages.map(async (message) => {
      try {
        await runDelivery(
          message as Message<Intent>,
          env,
          definitions,
          startedAt,
          maxIterations,
          expiresIn,
        );
        message.ack();
      } catch (error) {
        console.error("Ordo Queue processing failed", {
          messageId: message.id,
          queue: batch.queue,
          message: error instanceof Error ? error.message : String(error),
        });
        message.retry();
      }
    }),
  );
}
