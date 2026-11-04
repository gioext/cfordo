import { Ordo, type OrdoContext, type GoalParams } from "../../dist/index.js";

interface Input {
  value: number;
  mode?: "success" | "retry" | "parallel" | "expired" | "parallel-fail";
}
interface Env {
  DB: D1Database;
  QUEUE: Queue;
  WORKFLOW: Workflow<GoalParams>;
  EXPIRES_IN?: string;
  FAIL_SETUP?: string;
}

export class TestWorkflow extends Ordo<Env, Input> {
  setupCalls = 0;
  private readonly marker = "initialized subclass";

  async setup() {
    this.setupCalls++;
    if (this.env.FAIL_SETUP) throw new Error("setup failed");
    this.configure({ expiresIn: Number(this.env.EXPIRES_IN ?? 86400000) });
    await this.registerSteps();
  }

  async registerSteps() {
    await this.parallel(this.registerParallel);
    this.step({ name: "finalize", run: this.finalize });
  }

  async registerParallel() {
    this.step({
      name: "extract",
      run: this.extract,
      validate: this.validate,
      evaluate: this.evaluate,
    });
    this.step({ name: "second", run: this.second });
  }

  private assertInitialized() {
    if (
      this.setupCalls !== 1 ||
      this.marker !== "initialized subclass" ||
      !this.env.DB
    ) {
      throw new Error("Missing method binding or repeated/early setup");
    }
  }

  async extract(ctx: OrdoContext) {
    this.assertInitialized();
    const input = ctx.input().params as Input;
    if (input.mode === "parallel-fail") throw new Error("business failure");
    await ctx.complete({
      value: input.value,
      feedback: ctx.feedback?.reason ?? null,
    });
  }

  async validate(ctx: OrdoContext) {
    this.assertInitialized();
    if (ctx.input().result.value >= 0) await ctx.ok();
    else await ctx.ng("nonnegative value required");
  }

  async evaluate(ctx: OrdoContext) {
    this.assertInitialized();
    if ((ctx.input().params as Input).mode === "retry") {
      const row = await this.env.DB.prepare(
        "SELECT COUNT(*) AS n FROM cfordo_attempts WHERE goal_id = ? AND step_name = ? AND action = 'evaluate'",
      )
        .bind(ctx.goalId, ctx.stepName)
        .first<{ n: number }>();
      if ((row?.n ?? 0) < 2) {
        await ctx.ng("try again");
        return;
      }
    }
    if (ctx.input().result.value === ctx.input().params.value) await ctx.ok();
    else await ctx.ng("value mismatch");
  }

  async second(ctx: OrdoContext) {
    this.assertInitialized();
    if (ctx.input().params.mode === "parallel-fail") {
      await new Promise(function (resolve) {
        setTimeout(resolve, 250);
      });
    }
    await ctx.complete({ second: true });
  }

  async finalize(ctx: OrdoContext) {
    this.assertInitialized();
    await ctx.complete({ done: true });
  }
}

export default TestWorkflow.worker();
