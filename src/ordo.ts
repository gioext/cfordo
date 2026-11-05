import { createApi } from "./api.ts";
import { Definition } from "./core/definition.ts";
import type { OrdoEnv, OrdoOptions, StepDefinition } from "./types.ts";

export class Ordo<
  Env extends OrdoEnv = OrdoEnv,
  Params = any,
> implements ExportedHandler<Env> {
  private readonly definition = new Definition<Env, Params>();
  private readonly app = createApi<Env>(async (env) => ({
    start: (input) => this.definition.start(env, input),
    list: () => this.definition.list(env),
    get: (id) => this.definition.get(env, id),
  }));

  configure(options: OrdoOptions): void {
    this.definition.configure(options);
  }
  step<Result = any>(step: StepDefinition<Params, Result, Env>): void {
    this.definition.step(step);
  }
  parallel(callback: () => Promise<void>): Promise<void> {
    return this.definition.parallel(callback);
  }

  readonly fetch: ExportedHandlerFetchHandler<Env> = (request, env, ctx) =>
    this.app.fetch(request, env, ctx);
  readonly queue: ExportedHandlerQueueHandler<Env> = (batch, env) =>
    this.definition.queue(batch, env);
  readonly scheduled: ExportedHandlerScheduledHandler<Env> = (
    _controller,
    env,
  ) => this.definition.scheduled(env);
}
