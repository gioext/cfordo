import { Hono, type Context } from "hono";
import { initOrdo, Ordo, type OrdoContext } from "../../dist/index.js";

interface Input {
  value: number;
  mode?: "success" | "retry" | "parallel" | "expired" | "parallel-fail";
}
interface Env {
  DB: D1Database;
  JOBS: Queue;
  EXPIRED_JOBS: Queue;
  WORKFLOW: Workflow<Input>;
  EXPIRED_WORKFLOW: Workflow<Input>;
}

export class TestWorkflow extends Ordo<Env> {
  setupCalls = 0;
  private readonly marker = "initialized subclass";

  async setup() {
    this.setupCalls++;
    this.binding({ db: this.env.DB, queue: this.env.JOBS, workflow: this.env.WORKFLOW });
    this.configure({ expiresIn: 24 * 60 * 60 * 1000 });
    await this.registerSteps();
  }

  async registerSteps() {
    await this.parallel(this.registerParallel);
    this.step({ name: "finalize", run: this.finalize });
  }

  async registerParallel() {
    this.step({ name: "extract", run: this.extract, validate: this.validate, evaluate: this.evaluate });
    this.step({ name: "second", run: this.second });
  }

  private assertInitialized() {
    if (this.setupCalls !== 1 || this.marker !== "initialized subclass" || !this.env.DB) {
      throw new Error("Missing method binding or repeated/early setup");
    }
  }

  async extract(ctx: OrdoContext) {
    this.assertInitialized();
    const input = ctx.params<Input>();
    if (input.mode === "parallel-fail") throw new Error("business failure");
    return { value: input.value, feedback: ctx.feedback?.reason ?? null };
  }

  async validate(ctx: OrdoContext) {
    this.assertInitialized();
    return ctx.result<{ value: number }>().value >= 0 ? ctx.ok() : ctx.ng("nonnegative value required");
  }

  async evaluate(ctx: OrdoContext) {
    this.assertInitialized();
    if (ctx.params<Input>().mode === "retry") {
      const row = await this.env.DB.prepare("SELECT COUNT(*) AS n FROM cfordo_attempts WHERE goal_id = ? AND step_name = ?")
        .bind(ctx.goalId, ctx.stepName).first<{ n: number }>();
      if ((row?.n ?? 0) < 2) return ctx.ng("try again");
    }
    return ctx.result().value === ctx.params().value ? ctx.ok() : ctx.ng("value mismatch");
  }

  async second(ctx: OrdoContext) {
    this.assertInitialized();
    if (ctx.params().mode === "parallel-fail") {
      await new Promise(function (resolve) { setTimeout(resolve, 250); });
    }
    return { second: true };
  }

  async finalize() {
    this.assertInitialized();
    return { done: true };
  }
}

export class ExpiredWorkflow extends TestWorkflow {
  async setup() {
    this.setupCalls++;
    this.binding({ db: this.env.DB, queue: this.env.EXPIRED_JOBS, workflow: this.env.EXPIRED_WORKFLOW });
    this.configure({ expiresIn: 1 });
    await this.registerSteps();
  }
}

const app = new Hono<{ Bindings: Env }>();
async function start(c: Context<{ Bindings: Env }>) {
  const input = await c.req.json<Input>();
  const workflow = input.mode === "expired" ? c.env.EXPIRED_WORKFLOW : c.env.WORKFLOW;
  const instance = await workflow.create({ params: input });
  return c.json({ id: instance.id });
}
async function status(c: Context<{ Bindings: Env }>) {
  const id = c.req.query("id");
  if (!id) return c.text("id is required", 400);
  const workflow = c.req.query("mode") === "expired" ? c.env.EXPIRED_WORKFLOW : c.env.WORKFLOW;
  return c.json(await (await workflow.get(id)).status());
}
async function initialize(c: Context<{ Bindings: Env }>) {
  await initOrdo(c.env.DB);
  return c.text("ok");
}

async function lifecycle(c: Context<{ Bindings: Env }>) {
  // Hono types expose a subset of the native Workers execution context.
  const executionCtx = c.executionCtx as ExecutionContext;
  let setups = 0;
  class Probe extends Ordo<Env> {
    async setup() {
      setups++;
      await Promise.resolve();
      this.binding({ db: this.env.DB, queue: this.env.JOBS, workflow: this.env.WORKFLOW });
      this.step({ name: "noop", run: this.noop });
    }
    async noop() { return null; }
  }
  const handler = Probe.queue();
  const beforeReceiving = setups;
  const batch = { queue: "empty", messages: [], ackAll() {}, retryAll() {} };
  const instance = new Probe(executionCtx, c.env);
  await Promise.all([instance.queue(batch), instance.queue(batch)]);
  const sharedSetup = setups;
  await Promise.all([handler(batch, c.env, executionCtx), handler(batch, c.env, executionCtx)]);
  const separateInstances = setups;
  let failures = 0;
  class FailingProbe extends Ordo<Env> {
    async setup() { failures++; throw new Error("setup failed"); }
  }
  const failing = new FailingProbe(executionCtx, c.env);
  const rejected = await Promise.allSettled([failing.queue(batch), failing.queue(batch)]);
  await failing.queue(batch).catch(function () {});
  class MissingBindings extends Ordo<Env> {
    async setup() { this.step({ name: "noop", run: this.noop }); }
    async noop() { return null; }
  }
  let missingBinding = "";
  try { await new MissingBindings(executionCtx, c.env).queue(batch); }
  catch (error) { missingBinding = (error as Error).message; }
  return c.json({ beforeReceiving, sharedSetup, separateInstances, failures, rejected: rejected.map(function (result) { return result.status; }), missingBinding });
}
app.post("/start", start);
app.get("/status", status);
app.post("/init", initialize);
app.get("/lifecycle", lifecycle);

const normalQueue = TestWorkflow.queue();
const expiredQueue = ExpiredWorkflow.queue();
async function receive(batch: MessageBatch, env: Env, ctx: ExecutionContext) {
  const handler = batch.queue === "cfordo-test-expired-jobs" ? expiredQueue : normalQueue;
  return handler(batch, env, ctx);
}
export default { fetch: app.fetch, queue: receive } satisfies ExportedHandler<Env>;
