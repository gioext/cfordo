import {
  WorkflowEntrypoint,
  type WorkflowEvent,
  type WorkflowStep,
} from "cloudflare:workers";
import { createApi } from "./api.ts";
import { Definition } from "./core/definition.ts";
import type {
  GoalParams,
  OrdoEnv,
  OrdoOptions,
  StepDefinition,
} from "./types.ts";

export abstract class Ordo<
  Env extends OrdoEnv = OrdoEnv,
  Params = any,
> extends WorkflowEntrypoint<Env, GoalParams> {
  private readonly definition = new Definition<Params>(this.env, this);
  private initialization: Promise<void> | undefined;

  abstract setup(): Promise<void>;

  configure(options: OrdoOptions): void {
    this.definition.configure(options);
  }
  step<Result = any>(step: StepDefinition<Params, Result>): void {
    this.definition.step(step);
  }
  parallel(callback: () => Promise<void>): Promise<void> {
    return this.definition.parallel(callback);
  }

  async run(
    event: WorkflowEvent<GoalParams>,
    step: WorkflowStep,
  ): Promise<void> {
    await this.prepare();
    await this.definition.run(event, step);
  }

  /** One dedicated Worker provides this Ordo's HTTP and Queue entrypoints. */
  static worker<Env extends OrdoEnv>(
    this: new (ctx: ExecutionContext, env: Env) => Ordo<Env, any>,
  ): ExportedHandler<Env> {
    const Entrypoint = this;
    const resolve = async (env: Env, ctx: ExecutionContext) => {
      const instance = new Entrypoint(ctx, env);
      await instance.prepare();
      return instance.definition;
    };
    const app = createApi(resolve);
    return {
      fetch: (request, env, ctx) => app.fetch(request, env, ctx),
      queue: async (batch, env, ctx) => {
        const definition = await resolve(env, ctx);
        await definition.queue(batch, env, ctx);
      },
    };
  }

  private prepare(): Promise<void> {
    // Setup runs after subclass fields initialize and once per instance.
    return (this.initialization ??= Promise.resolve().then(async () => {
      const pending = this.setup();
      if (!pending || typeof pending.then !== "function")
        throw new TypeError("setup() must be asynchronous");
      await pending;
      this.definition.ready();
    }));
  }
}
