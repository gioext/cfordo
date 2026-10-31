import { getAttempt, getGoal, insertAttempt, listAttempts, updateAttempt } from "../db/store.ts";
import {
  completionType, NO_WORKFLOW_RETRIES,
  type Attempt, type AttemptOutcome, type Intent,
  type RegisteredStep, type Runtime, type OrdoContext,
} from "../types.ts";
import { getGoalStatus } from "./goal.ts";
import { createContext, recordError, runCheck } from "./validation.ts";

const limits = { exception: 3, validate: 3, evaluate: 10 } as const;

function budgetExhausted(attempts: readonly Attempt[]): boolean {
  const failures = { exception: 0, validate: 0, evaluate: 0 };
  for (const attempt of attempts) {
    if (attempt.error?.fatal) return true;
    if (attempt.error) failures.exception++;
    if (attempt.validation?.ok === false) failures.validate++;
    if (attempt.evaluation?.ok === false) failures.evaluate++;
  }
  return (Object.keys(limits) as (keyof typeof limits)[]).some((source) => failures[source] >= limits[source]);
}

export function buildFeedback(attempts: readonly Attempt[]): OrdoContext["feedback"] {
  for (let index = attempts.length - 1; index >= 0; index--) {
    const attempt = attempts[index];
    for (const [source, result] of [
      ["evaluate", attempt.evaluation], ["validate", attempt.validation],
    ] as const) {
      if (result?.ok === false) return { source, reason: result.reason };
    }
  }
  return undefined;
}

async function retryOutcome(runtime: Runtime, attempt: Attempt): Promise<AttemptOutcome> {
  return budgetExhausted(await listAttempts(runtime.db, attempt.goalId, attempt.stepName)) ? "failed" : "retry";
}

export async function evaluateAttempt(runtime: Runtime, definition: RegisteredStep, id: number): Promise<AttemptOutcome> {
  const attempt = await getAttempt(runtime.db, id);
  const goal = await getGoal(runtime.db, attempt.goalId);
  const status = getGoalStatus(goal);
  if (status === "expired") return "expired";
  if (status === "failed") return "failed";
  if (attempt.status === "completed") return "completed";
  if (attempt.status === "failed") return retryOutcome(runtime, attempt);

  if (attempt.error || attempt.validation?.ok === false) {
    await updateAttempt(runtime.db, id, { status: "failed", finishedAt: Date.now() });
    return retryOutcome(runtime, attempt);
  }
  if (attempt.output === undefined) {
    await updateAttempt(runtime.db, id, {
      status: "failed", finishedAt: Date.now(),
      error: recordError("Completion event arrived without a saved Worker result", "configuration", { fatal: true }),
    });
    return "failed";
  }
  if (!definition.evaluate) {
    await updateAttempt(runtime.db, id, { status: "completed", finishedAt: Date.now() });
    return "completed";
  }

  await updateAttempt(runtime.db, id, { status: "evaluating" });
  const details: Pick<OrdoContext, "goalId" | "stepName" | "attemptId" | "feedback"> = {
    goalId: attempt.goalId, stepName: attempt.stepName, attemptId: id,
  };
  const prior = (await listAttempts(runtime.db, attempt.goalId, attempt.stepName)).filter((item) => item.id < id);
  const feedback = buildFeedback(prior);
  if (feedback) details.feedback = feedback;
  let result;
  try {
    result = await runCheck(definition.evaluate, createContext(details, goal.input, attempt.output));
  } catch (error) {
    await updateAttempt(runtime.db, id, {
      error: recordError(error, "evaluate"), status: "failed", finishedAt: Date.now(),
    });
    return retryOutcome(runtime, attempt);
  }
  await updateAttempt(runtime.db, id, {
    evaluation: result, status: result.ok ? "completed" : "failed", finishedAt: Date.now(),
  });
  return result.ok ? "completed" : retryOutcome(runtime, attempt);
}

export async function executeAttempt(runtime: Runtime, definition: RegisteredStep, intent: Intent): Promise<AttemptOutcome> {
  if (intent.resume?.phase === "evaluate") {
    await runtime.step.do(`ordo:restore:${intent.attemptId}`, NO_WORKFLOW_RETRIES, async () => {
      const previous = await getAttempt(runtime.db, intent.resume!.attemptId);
      await updateAttempt(runtime.db, intent.attemptId, {
        output: previous.output, validation: previous.validation,
      });
      return null;
    });
  } else {
    const sent = await runtime.step.do(`ordo:dispatch:${intent.attemptId}`, NO_WORKFLOW_RETRIES, async () => {
      if (getGoalStatus(await getGoal(runtime.db, intent.goalId)) !== "running") return false;
      const current = await getAttempt(runtime.db, intent.attemptId);
      if (current.status === "completed" || current.status === "failed") return false;
      try {
        await runtime.queue.send(intent);
        return true;
      } catch (error) {
        await updateAttempt(runtime.db, intent.attemptId, {
          error: recordError(error, "dispatch"), status: "failed", finishedAt: Date.now(),
        });
        return false;
      }
    });
    if (sent) {
      const event = await runtime.step.waitForEvent(`ordo:complete:${intent.attemptId}`, {
        type: completionType(intent.attemptId),
      });
      if (!event.payload || typeof event.payload !== "object" || !("attemptId" in event.payload) || event.payload.attemptId !== intent.attemptId) {
        throw new Error("Unexpected completion event");
      }
    }
  }
  return runtime.step.do(`ordo:evaluate:${intent.attemptId}`, NO_WORKFLOW_RETRIES, () => evaluateAttempt(runtime, definition, intent.attemptId));
}

export async function executeStep(runtime: Runtime, goalId: number, definition: RegisteredStep, position: number): Promise<Exclude<AttemptOutcome, "retry">> {
  for (let cycle = 0; ; cycle++) {
    // The decision is checkpointed so Workflow replay follows the same launches.
    const encoded = await runtime.step.do(`ordo:plan:${goalId}:${position}:${cycle}`, NO_WORKFLOW_RETRIES, async () => {
      const goalStatus = getGoalStatus(await getGoal(runtime.db, goalId));
      if (goalStatus === "expired" || goalStatus === "failed" || goalStatus === "completed") return JSON.stringify({ status: goalStatus });
      const history = await listAttempts(runtime.db, goalId, definition.name);
      const last = history.at(-1);
      if (last?.status === "completed") return JSON.stringify({ status: "completed" });
      if (budgetExhausted(history)) return JSON.stringify({ status: "failed" });
      const attempt = last && last.status !== "failed" ? last : await insertAttempt(runtime.db, goalId, definition.name);
      if (!attempt) return JSON.stringify({ status: getGoalStatus(await getGoal(runtime.db, goalId)) });
      const prior = history.filter((item) => item.id < attempt.id);
      const feedback = buildFeedback(prior);
      const previous = prior.at(-1);
      const source = previous?.error?.source;
      const resume = previous?.status === "failed" && (source === "validate" || source === "evaluate")
        ? { phase: source, attemptId: previous.id } : undefined;
      const intent: Intent = {
        protocol: "cfordo/1", goalId, stepName: definition.name, attemptId: attempt.id,
        instanceId: runtime.event.instanceId,
        ...(feedback ? { feedback } : {}), ...(resume ? { resume } : {}),
      };
      return JSON.stringify({ intent });
    });
    const plan = JSON.parse(encoded) as { status?: Exclude<AttemptOutcome, "retry">; intent?: Intent };
    if (plan.status) return plan.status;
    if (!plan.intent) throw new Error("No Attempt planned");
    const outcome = await executeAttempt(runtime, definition, plan.intent);
    if (outcome !== "retry") return outcome;
  }
}
