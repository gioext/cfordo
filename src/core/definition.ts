import { createGoal, getGoalStatus } from "./goal.ts";
import { failGoal, runPlanner } from "./planner.ts";
import { createQueueConsumer, createWorker } from "./worker.ts";
import { initOrdo } from "../db/init.ts";
import type {
  DatabaseBinding,
  OrdoBindings,
  OrdoOptions,
  OrdoRegistration,
  QueueHandler,
  WorkflowStepBinding,
  RegisteredStep,
  RunStatus,
  StepDefinition,
  WorkerExecutor,
} from "../types.ts";

/** Shared registration and execution logic, independent of the Cloudflare entrypoint. */
export class Definition implements OrdoRegistration {
  private bindings: OrdoBindings | undefined;
  private expiresIn = 24 * 60 * 60 * 1000;
  private readonly executors = new Map<string, WorkerExecutor>();
  private readonly steps = new Set<string>();
  private readonly playbook: RegisteredStep[][] = [];
  private group: RegisteredStep[] | null = null;
  private frozen = false;
  private readonly owner: unknown;
  readonly queue: QueueHandler<unknown>;

  constructor(owner?: unknown) {
    this.owner = owner;
    this.queue = createQueueConsumer(this.executors, async () => {
      this.ready();
      return this.resolveBindings();
    });
  }

  binding(bindings: OrdoBindings): void {
    this.assertMutable();
    if (this.bindings) throw new Error("Bindings have already been configured");
    if (
      !bindings ||
      typeof bindings !== "object" ||
      typeof bindings.db?.prepare !== "function" ||
      typeof bindings.db?.batch !== "function" ||
      typeof bindings.queue?.send !== "function" ||
      typeof bindings.workflow?.get !== "function"
    ) {
      throw new TypeError("binding() requires db, queue and workflow bindings");
    }
    if (
      Object.keys(bindings).some(
        (key) => !["db", "queue", "workflow"].includes(key),
      )
    ) {
      throw new TypeError("binding() only accepts db, queue and workflow");
    }
    this.bindings = Object.freeze({ ...bindings });
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

  step(definition: StepDefinition): void {
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
    this.resolveBindings();
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
    event: { instanceId: string; payload: unknown },
    step: WorkflowStepBinding,
  ): Promise<RunStatus> {
    let goalId: number | undefined;
    let db: DatabaseBinding | undefined;
    try {
      this.ready();
      const bindings = this.resolveBindings();
      db = bindings.db;
      const { queue } = bindings;
      const expiresIn = this.expiresIn;
      if (!step || !event?.instanceId)
        throw new Error("run requires a Workflow event and step");
      await initOrdo(db);
      const goal = await createGoal(
        db,
        step,
        "ordo:goal:0",
        event.payload,
        expiresIn,
      );
      goalId = goal.id;
      const status = getGoalStatus(goal);
      if (status === "completed" || status === "failed" || status === "expired")
        return status;
      return await runPlanner(
        { db, queue, step, event },
        goal.id,
        this.playbook,
      );
    } catch {
      if (goalId !== undefined && db) {
        try {
          return await failGoal(db, goalId);
        } catch {
          // A live caller still gets a status even if failure cannot be stored.
        }
      }
      return "failed";
    }
  }

  private resolveBindings(): OrdoBindings {
    if (!this.bindings)
      throw new Error("setup() must call binding() before execution");
    return this.bindings;
  }

  private assertMutable(): void {
    if (this.frozen)
      throw new Error("Registrations cannot change after run starts");
  }
}
