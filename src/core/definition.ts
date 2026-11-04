import { attachWorkflow, getGoal, updateGoal } from "../db/store.ts";
import { recordError } from "./validation.ts";
import { startGoal, readGoal, readGoals, getGoalStatus } from "./goal.ts";
import { runPlanner } from "./planner.ts";
import { createQueueConsumer, createWorker } from "./worker.ts";
import { initOrdo } from "../db/init.ts";
import type {
  OrdoBindings,
  OrdoOptions,
  OrdoRegistration,
  QueueHandler,
  WorkflowStepBinding,
  RegisteredStep,
  StepDefinition,
  WorkerExecutor,
  WorkflowIdentity,
  GoalParams,
  CoreEnv,
} from "../types.ts";

/** Shared registration and execution logic, independent of the Cloudflare entrypoint. */
export class Definition<Params = any> implements OrdoRegistration<Params> {
  private readonly bindings: OrdoBindings;
  private expiresIn = 24 * 60 * 60 * 1000;
  private readonly executors = new Map<string, WorkerExecutor>();
  private readonly steps = new Set<string>();
  private readonly playbook: RegisteredStep[][] = [];
  private group: RegisteredStep[] | null = null;
  private frozen = false;
  private readonly owner: unknown;
  readonly queue: QueueHandler<unknown>;

  constructor(env: CoreEnv, owner?: unknown) {
    this.owner = owner;
    this.bindings = { db: env?.DB, queue: env?.QUEUE, workflow: env?.WORKFLOW };
    this.queue = createQueueConsumer(this.executors, async () => {
      this.ready();
      return this.bindings;
    });
  }

  async start(input: unknown): Promise<number> {
    this.ready();
    return startGoal(this.bindings, input, this.expiresIn);
  }

  async list() {
    this.ready();
    return readGoals(this.bindings, this.playbook.flat());
  }

  async get(id: number) {
    this.ready();
    return readGoal(this.bindings, this.playbook.flat(), id);
  }

  configure(options: OrdoOptions): void {
    this.assertMutable();
    if (
      !options ||
      typeof options !== "object" ||
      Object.keys(options).some((key) => key !== "expiresIn")
    ) {
      throw new TypeError("configure() only accepts expiresIn");
    }
    const expiresIn = options.expiresIn ?? 24 * 60 * 60 * 1000;
    if (!Number.isSafeInteger(expiresIn) || expiresIn <= 0) {
      throw new TypeError(
        "expiresIn must be a positive number of milliseconds",
      );
    }
    this.expiresIn = expiresIn;
  }

  step<Result = any>(definition: StepDefinition<Params, Result>): void {
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
    const registered: RegisteredStep = Object.freeze({
      ...definition,
      run: definition.run.bind(this.owner),
      ...(definition.validate
        ? { validate: definition.validate.bind(this.owner) }
        : {}),
      ...(definition.evaluate
        ? { evaluate: definition.evaluate.bind(this.owner) }
        : {}),
    });
    this.steps.add(registered.name);
    this.executors.set(registered.name, createWorker(registered));
    if (this.group) this.group.push(registered);
    else this.playbook.push([registered]);
  }

  ready(): void {
    if (this.group)
      throw new Error("Await parallel registration before execution");
    if (
      typeof this.bindings.db?.prepare !== "function" ||
      typeof this.bindings.db?.batch !== "function" ||
      typeof this.bindings.queue?.send !== "function" ||
      typeof this.bindings.workflow?.get !== "function" ||
      typeof this.bindings.workflow?.create !== "function"
    )
      throw new TypeError("Ordo requires DB, QUEUE and WORKFLOW bindings");
    if (!this.steps.size) throw new Error("At least one Step is required");
    this.frozen = true;
  }

  async parallel(callback: () => Promise<void>): Promise<void> {
    this.assertMutable();
    if (this.group) throw new Error("Nested parallel groups are not supported");
    if (typeof callback !== "function")
      throw new TypeError("parallel requires an async callback");
    const group: RegisteredStep[] = [];
    this.group = group;
    this.playbook.push(group);
    try {
      const pending = callback.call(this.owner);
      if (!pending || typeof pending.then !== "function")
        throw new TypeError("parallel callback must be asynchronous");
      await pending;
      if (!group.length)
        throw new Error("A parallel group must contain a Step");
    } catch (error) {
      this.playbook.splice(this.playbook.indexOf(group), 1);
      for (const step of group) {
        this.steps.delete(step.name);
        this.executors.delete(step.name);
      }
      throw error;
    } finally {
      this.group = null;
    }
  }

  async run(
    event: WorkflowIdentity & { payload: GoalParams },
    step: WorkflowStepBinding,
  ): Promise<void> {
    this.ready();
    const bindings = this.bindings;
    if (!step || !event?.instanceId || !event.workflowName)
      throw new Error("run requires a Workflow event and step");
    await initOrdo(bindings.db);
    if (
      !Number.isSafeInteger(event.payload?.goalId) ||
      event.payload.goalId <= 0
    )
      throw new TypeError("Workflow requires a positive Goal ID");
    await attachWorkflow(
      bindings.db,
      event.payload.goalId,
      event.instanceId,
      event.workflowName,
    );
    const goal = await getGoal(bindings.db, event.payload.goalId);
    const status = getGoalStatus(goal);
    if (status === "completed" || status === "failed" || status === "expired")
      return;
    try {
      await runPlanner(
        { db: bindings.db, queue: bindings.queue, step, event },
        goal.id,
        this.playbook,
      );
    } catch (error) {
      if (getGoalStatus(await getGoal(bindings.db, goal.id)) === "expired")
        return;
      await updateGoal(
        bindings.db,
        goal.id,
        "failed",
        recordError(error, "configuration"),
      );
      throw error;
    }
  }

  private assertMutable(): void {
    if (this.frozen)
      throw new Error("Registrations cannot change after run starts");
  }
}
