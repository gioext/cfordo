import { createApi } from "./api.ts";
import { Definition } from "./core/definition.ts";
import type { OrdoEnv, OrdoOptions, Plan, StepDefinition } from "./types.ts";

export class Ordo<
  Env extends OrdoEnv = OrdoEnv,
  Params = any,
> implements ExportedHandler<Env> {
  private readonly definition = new Definition<Env, Params>();
  private readonly app = createApi<Env>(async (env) => ({
    start: (input) => this.definition.start(env, input),
    list: () => this.definition.list(env),
    get: (id) => this.definition.get(env, id),
    stop: (id) => this.definition.stop(env, id),
  }));

  configure(options: OrdoOptions): void {
    this.definition.configure(options);
  }
  plan(callback: Plan<Params, Env>): void {
    this.definition.plan(callback);
  }
  step<Result = any, P = Params>(step: StepDefinition<P, Result, Env>) {
    return this.definition.step(step);
  }
  parallel(callback: () => Promise<void>): Promise<void> {
    return this.definition.parallel(callback);
  }

  readonly fetch: ExportedHandlerFetchHandler<Env> = (request, env, ctx) =>
    this.app.fetch(request, env, ctx);
  readonly queue: ExportedHandlerQueueHandler<Env> = (batch, env) =>
    this.definition.queue(batch, env, Date.now());
  readonly scheduled: ExportedHandlerScheduledHandler<Env> = (
    _controller,
    env,
  ) => this.definition.scheduled(env);
}
