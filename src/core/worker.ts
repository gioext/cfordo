import { initOrdo } from "../db/init.ts";
import {
  beginAttempt,
  ExecutionStopped,
  exhaustIteration,
  failAttempt,
  finishAttempt,
  getAttempt,
  getGoal,
  getIteration,
  saveIterationResult,
} from "../db/store.ts";
import type {
  Action,
  Attempt,
  Intent,
  JsonValue,
  OrdoContext,
  OrdoEnv,
  RegisteredStep,
} from "../types.ts";
import { createContext } from "./context.ts";
import { readResults } from "./engine.ts";
import { recordError } from "./validation.ts";
import { executionResult, improvement } from "./progress.ts";

function isIntent(value: unknown): value is Intent {
  if (!value || typeof value !== "object") return false;
  const item = value as Record<string, unknown>;
  return (
    item.protocol === "cfordo/3" &&
    Number.isSafeInteger(item.iterationId) &&
    Number(item.iterationId) > 0 &&
    typeof item.dispatchToken === "string"
  );
}

async function runIteration<Env extends OrdoEnv>(
  message: Message<Intent>,
  env: Env,
  definitions: ReadonlyMap<string, RegisteredStep<Env>>,
): Promise<void> {
  const round = await getIteration(env.DB, message.body.iterationId);
  const goal = await getGoal(env.DB, round.goalId);
  if (Date.now() >= goal.expiresAt) return;
  let action: Action = "run";
  let attempt: Attempt | undefined;
  try {
    const definition = definitions.get(round.stepName);
    if (!definition) throw new Error(`Step not registered: ${round.stepName}`);
    const { rounds, history, results } = await readResults(env.DB, goal.id);
    const previous = rounds.find(
      (r) =>
        r.stepName === round.stepName && r.iteration === round.iteration - 1,
    );
    const prior = previous
      ? executionResult(history, previous, results)
      : undefined;
    const feedback =
      prior?.result && !prior.result.error ? improvement(prior.last) : null;
    if (round.iteration > 1 && !feedback)
      throw new Error(
        "Improvement iteration has no preceding negative verdict",
      );
    const shared = createContext(
      env,
      goal.id,
      round.stepName,
      goal.input,
      {
        iteration: round.iteration,
        source: feedback?.source ?? null,
        reason: feedback?.reason ?? null,
      },
      definitions,
    );
    let runId: number | null = null;
    let previousId: number | null = null;
    let output: JsonValue | undefined;
    for (action of ["run", "validate", "evaluate"] as const) {
      const handler = definition[action] as
        | ((ctx: OrdoContext<any, any, Action, Env>) => Promise<void>)
        | undefined;
      if (!handler) continue;
      attempt = await beginAttempt(
        env.DB,
        round,
        message.body.dispatchToken,
        message.attempts,
        action,
        action === "run" ? null : runId,
        previousId,
      );
      shared.enter(attempt, output);
      await handler(shared.context);
      if (!shared.hasOutcome())
        throw new Error("Action ended without saving its result or verdict");
      await finishAttempt(env.DB, attempt);
      const finished = await getAttempt(env.DB, attempt.id);
      previousId = attempt.id;
      if (action === "run") {
        runId = attempt.id;
        output = finished.output;
      }
      if (improvement(finished)) break;
    }
    if (!attempt) throw new Error("Iteration has no run action");
    await saveIterationResult(env.DB, round.id, attempt.id);
  } catch (error) {
    if (error instanceof ExecutionStopped) return;
    if (attempt) await failAttempt(env.DB, attempt, recordError(error, action));
    throw error;
  }
}

export async function consumeQueue<Env extends OrdoEnv>(
  batch: MessageBatch<unknown>,
  env: Env,
  definitions: ReadonlyMap<string, RegisteredStep<Env>>,
  deadLetterQueue: string,
): Promise<void> {
  await initOrdo(env.DB);
  const deadLetter = batch.queue === deadLetterQueue;
  await Promise.all(
    batch.messages.map(async (message) => {
      try {
        if (!isIntent(message.body))
          throw new Error("Invalid cfordo iteration message");
        if (deadLetter) {
          const round = await getIteration(env.DB, message.body.iterationId);
          await exhaustIteration(env.DB, round, message.body.dispatchToken);
        } else {
          await runIteration(message as Message<Intent>, env, definitions);
        }
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
