import { listPendingGoals } from "../db/store.ts";
import { startGoal, readGoal, readGoals } from "./goal.ts";
import { runPlanner } from "./planner.ts";
import { consumeQueue } from "./worker.ts";
import { initOrdo } from "../db/init.ts";
import type {
  OrdoEnv,
  OrdoOptions,
  OrdoRegistration,
  RegisteredStep,
  StepDefinition,
} from "../types.ts";

/** Registrations are shared; bindings and execution state belong to each invocation. */
export class Definition<
  Env extends OrdoEnv,
  Params = any,
> implements OrdoRegistration<Params, Env> {
  private expiresIn = 24 * 60 * 60 * 1000;
  private maxIterations = 3;
  private readonly steps = new Map<string, RegisteredStep<Env>>();
  private readonly playbook: RegisteredStep<Env>[][] = [];
  private group: RegisteredStep<Env>[] | null = null;
  private frozen = false;

  async start(env: Env, input: unknown): Promise<number> {
    this.ready(env);
    return startGoal(env.DB, input);
  }

  async list(env: Env) {
    this.ready(env);
    return readGoals(
      env.DB,
      this.playbook.flat(),
      this.maxIterations,
      this.expiresIn,
    );
  }

  async get(env: Env, id: number) {
    this.ready(env);
    return readGoal(
      env.DB,
      this.playbook.flat(),
      id,
      this.maxIterations,
      this.expiresIn,
    );
  }

  async queue(
    batch: MessageBatch<unknown>,
    env: Env,
    startedAt: number,
  ): Promise<void> {
    this.ready(env);
    await consumeQueue(
      batch,
      env,
      this.steps,
      startedAt,
      this.maxIterations,
      this.expiresIn,
    );
  }

  async scheduled(env: Env): Promise<void> {
    this.ready(env);
    await initOrdo(env.DB);
    const goals = await listPendingGoals(env.DB);
    const failures: unknown[] = [];
    for (const goal of goals) {
      try {
        await runPlanner(
          env,
          goal.id,
          this.playbook,
          this.maxIterations,
          this.expiresIn,
        );
      } catch (error) {
        // A transient outage must neither fail the business Goal nor block other Goals.
        console.error("Ordo scheduling failed", { goalId: goal.id, error });
        failures.push(error);
      }
    }
    if (failures.length)
      throw new AggregateError(failures, "Some Goals could not be scheduled");
  }

  configure(options: OrdoOptions): void {
    this.assertMutable();
    if (
      !options ||
      typeof options !== "object" ||
      Object.keys(options).some(
        (key) => !["expiresIn", "maxIterations"].includes(key),
      )
    ) {
      throw new TypeError(
        "configure() only accepts expiresIn and maxIterations",
      );
    }
    const expiresIn = options.expiresIn ?? this.expiresIn;
    const maxIterations = options.maxIterations ?? this.maxIterations;
    if (!Number.isSafeInteger(expiresIn) || expiresIn <= 0) {
      throw new TypeError(
        "expiresIn must be a positive number of milliseconds",
      );
    }
    if (!Number.isSafeInteger(maxIterations) || maxIterations <= 0) {
      throw new TypeError(
        "maxIterations must be a positive safe integer including the initial run",
      );
    }
    this.expiresIn = expiresIn;
    this.maxIterations = maxIterations;
  }

  step<Result = any>(definition: StepDefinition<Params, Result, Env>): void {
    this.assertMutable();
    if (
      !definition ||
      typeof definition.name !== "string" ||
      !definition.name ||
      typeof definition.run !== "function"
    ) {
      throw new TypeError("Step requires a name and run function");
    }
    if (this.steps.has(definition.name))
      throw new Error(`Step already registered: ${definition.name}`);
    if (
      Object.keys(definition).some(
        (key) => !["name", "run", "validate", "evaluate"].includes(key),
      )
    ) {
      throw new TypeError("Step only accepts name, run, validate and evaluate");
    }
    if (
      definition.validate !== undefined &&
      typeof definition.validate !== "function"
    )
      throw new TypeError("validate must be a function");
    if (
      definition.evaluate !== undefined &&
      typeof definition.evaluate !== "function"
    )
      throw new TypeError("evaluate must be a function");
    const registered: RegisteredStep<Env> = Object.freeze({ ...definition });
    this.steps.set(registered.name, registered);
    if (this.group) this.group.push(registered);
    else this.playbook.push([registered]);
  }

  ready(env: Env): void {
    if (this.group)
      throw new Error("Await parallel registration before execution");
    if (
      typeof env?.DB?.prepare !== "function" ||
      typeof env?.DB?.batch !== "function" ||
      typeof env?.QUEUE?.send !== "function"
    )
      throw new TypeError("Ordo requires DB and QUEUE bindings");
    if (!this.steps.size) throw new Error("At least one Step is required");
    this.frozen = true;
  }

  async parallel(callback: () => Promise<void>): Promise<void> {
    this.assertMutable();
    if (this.group) throw new Error("Nested parallel groups are not supported");
    if (typeof callback !== "function")
      throw new TypeError("parallel requires an async callback");
    const group: RegisteredStep<Env>[] = [];
    this.group = group;
    this.playbook.push(group);
    try {
      const pending = callback();
      if (!pending || typeof pending.then !== "function")
        throw new TypeError("parallel callback must be asynchronous");
      await pending;
      if (!group.length)
        throw new Error("A parallel group must contain a Step");
    } catch (error) {
      this.playbook.splice(this.playbook.indexOf(group), 1);
      for (const step of group) {
        this.steps.delete(step.name);
      }
      throw error;
    } finally {
      this.group = null;
    }
  }

  private assertMutable(): void {
    if (this.frozen)
      throw new Error("Registrations cannot change after processing starts");
  }
}
