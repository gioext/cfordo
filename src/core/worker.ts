import { initOrdo } from "../db/init.ts";
import {
  beginAttempt,
  claimIteration,
  ExecutionStopped,
  exhaustIteration,
  finishAttempt,
  finishIteration,
  getAttempt,
  getGoal,
  getIteration,
  listAttempts,
  listIterations,
  recordIterationError,
} from "../db/store.ts";
import type {
  Action,
  Intent,
  JsonValue,
  OrdoContext,
  OrdoEnv,
  RegisteredStep,
} from "../types.ts";
import { getGoalStatus } from "./goal.ts";
import { createContext } from "./context.ts";
import { recordError } from "./validation.ts";
import { improvement } from "./progress.ts";

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
): Promise<void | false> {
  let round = await getIteration(env.DB, message.body.iterationId);
  if (
    round.status === "completed" ||
    round.status === "failed" ||
    round.dispatchToken !== message.body.dispatchToken
  )
    return;
  const goal = await getGoal(env.DB, round.goalId);
  if (getGoalStatus(goal) !== "running") return;
  if (round.messageId && round.messageId !== message.id) return;
  const token = crypto.randomUUID();
  if (
    !(await claimIteration(
      env.DB,
      round.id,
      message.id,
      message.attempts,
      token,
    ))
  ) {
    round = await getIteration(env.DB, round.id);
    if (
      round.status === "completed" ||
      round.status === "failed" ||
      round.messageId !== message.id
    )
      return;
    // A concurrent duplicate must not acknowledge work that has not finished.
    message.retry({ delaySeconds: 15 * 60 });
    return false;
  }
  round = await getIteration(env.DB, round.id);
  let action: Action = "run";
  try {
    const definition = definitions.get(round.stepName);
    if (!definition) throw new Error(`Step not registered: ${round.stepName}`);
    const rounds = await listIterations(env.DB, goal.id, round.stepName);
    const history = await listAttempts(env.DB, goal.id, round.stepName);
    const previous = rounds.find((r) => r.iteration === round.iteration - 1);
    const feedback = previous
      ? improvement(
          history
            .filter(
              (a) =>
                a.iterationId === previous.id &&
                a.delivery === previous.delivery,
            )
            .at(-1),
        )
      : null;
    if (
      round.iteration > 1 &&
      (!previous || previous.status !== "completed" || !feedback)
    )
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
      token,
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
      const attempt = await beginAttempt(
        env.DB,
        round,
        token,
        action,
        action === "run" ? null : runId,
        previousId,
      );
      shared.enter(attempt, output);
      await handler(shared.context);
      if (!shared.hasOutcome())
        throw new Error("Action ended without saving its result or verdict");
      await finishAttempt(env.DB, attempt, token);
      const finished = await getAttempt(env.DB, attempt.id);
      previousId = attempt.id;
      if (action === "run") {
        runId = attempt.id;
        output = finished.output;
      }
      if (improvement(finished)) break;
    }
    await finishIteration(env.DB, round.id, token);
  } catch (error) {
    if (error instanceof ExecutionStopped) return;
    await recordIterationError(
      env.DB,
      round.id,
      token,
      recordError(error, action),
    );
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
          if (round.dispatchToken === message.body.dispatchToken)
            await exhaustIteration(env.DB, round.id);
        } else {
          if (
            (await runIteration(
              message as Message<Intent>,
              env,
              definitions,
            )) === false
          )
            return;
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
