import { saveOutcome } from "../db/store.ts";
import type {
  Action,
  Attempt,
  ImprovementFeedback,
  JsonValue,
  OrdoContext,
  OrdoEnv,
  RegisteredStep,
} from "../types.ts";
import { readResult } from "./goal.ts";
import { assertJson } from "./validation.ts";

export function createContext<Env extends OrdoEnv>(
  env: Env,
  goalId: number,
  stepName: string,
  params: JsonValue,
  feedback: ImprovementFeedback,
  definitions: ReadonlyMap<string, RegisteredStep<Env>>,
  maxIterations: number,
  expiresIn: number,
) {
  let current: Attempt;
  let result: JsonValue | undefined;
  let saved = false;
  const context: OrdoContext<any, any, Action, Env> = Object.freeze({
    env,
    goalId,
    stepName,
    get attemptId() {
      return current.id;
    },
    feedback: Object.freeze({ ...feedback }),
    input() {
      return structuredClone({
        params,
        result: current.action === "run" ? undefined : result,
      });
    },
    async result<T = any>(name: string): Promise<T> {
      const definition = definitions.get(name);
      if (!definition) throw new Error(`Step not registered: ${name}`);
      return readResult<T>(
        env.DB,
        goalId,
        definition,
        maxIterations,
        expiresIn,
      );
    },
    async complete(value: unknown): Promise<void> {
      if (current.action !== "run")
        throw new TypeError("complete() is only available to run");
      assertJson(value, "Business result");
      await saveOutcome(env.DB, current, value, expiresIn);
      saved = true;
    },
    async ok(): Promise<void> {
      if (arguments.length)
        throw new TypeError("ok() does not accept arguments");
      if (current.action !== "validate" && current.action !== "evaluate")
        throw new TypeError("ok() is only available to checks");
      await saveOutcome(env.DB, current, { ok: true }, expiresIn);
      saved = true;
    },
    async ng(reason: string): Promise<void> {
      if (
        arguments.length !== 1 ||
        typeof reason !== "string" ||
        !reason.trim()
      )
        throw new TypeError("ng() requires one non-empty reason");
      if (current.action !== "validate" && current.action !== "evaluate")
        throw new TypeError("ng() is only available to checks");
      await saveOutcome(env.DB, current, { ok: false, reason }, expiresIn);
      saved = true;
    },
  });
  return {
    context,
    enter(attempt: Attempt, output: JsonValue | undefined) {
      current = attempt;
      result = output;
      saved = false;
    },
    hasOutcome: () => saved,
  };
}
