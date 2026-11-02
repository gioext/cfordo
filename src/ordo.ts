import {
  WorkflowEntrypoint,
  type WorkflowEvent,
  type WorkflowStep,
} from "cloudflare:workers";
import { Definition } from "./core/definition.ts";
import type {
  OrdoBindings,
  OrdoOptions,
  QueueBatch,
  RunStatus,
  StepDefinition,
} from "./types.ts";

export abstract class Ordo<Env = unknown> extends WorkflowEntrypoint<
  Env,
  unknown
> {
  private readonly definition = new Definition(this);
  private initialization: Promise<void> | undefined;

  abstract setup(): Promise<void>;

  binding(bindings: OrdoBindings): void {
    this.definition.binding(bindings);
  }
  configure(options: OrdoOptions): void {
    this.definition.configure(options);
  }
  step(step: StepDefinition): void {
    this.definition.step(step);
  }
  parallel(callback: () => Promise<void>): Promise<void> {
    return this.definition.parallel(callback);
  }

  async run(
    event: WorkflowEvent<unknown>,
    step: WorkflowStep,
  ): Promise<RunStatus> {
    await this.prepare();
    return this.definition.run(event, step);
  }

  async queue(batch: QueueBatch): Promise<void> {
    await this.prepare();
    return this.definition.queue(batch, this.env, this.ctx);
  }

  /** Creates a handler now, and a fresh subclass instance for each Queue event. */
  static queue<Bindings>(
    this: new (ctx: ExecutionContext, env: Bindings) => Ordo<Bindings>,
  ): (
    batch: QueueBatch,
    env: Bindings,
    ctx: ExecutionContext,
  ) => Promise<void> {
    const Entrypoint = this;
    return async function (batch, env, ctx) {
      const instance = new Entrypoint(ctx, env);
      await instance.queue(batch);
    };
  }

  private prepare(): Promise<void> {
    // Defer setup until after construction, when subclass fields and env exist.
    // Concurrent calls share setup; failure stays failed on this instance.
    return (this.initialization ??= Promise.resolve().then(async () => {
      const pending = this.setup();
      if (!pending || typeof pending.then !== "function")
        throw new TypeError("setup() must be asynchronous");
      await pending;
      this.definition.ready();
    }));
  }
}
