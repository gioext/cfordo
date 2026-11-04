import { Ordo } from "cfordo";
import type { WorkflowEntrypoint } from "cloudflare:workers";

type Params = { shopId: string; fields?: string[] };
interface Env {
  DB: D1Database;
  QUEUE: Queue;
  WORKFLOW: Workflow<
    Parameters<import("./consumer.js").TestWorkflow["run"]>[0]["payload"]
  >;
}

export class TestWorkflow extends Ordo<Env, Params> {
  async setup() {
    this.configure({ expiresIn: 1000 });
    this.step<{ amount: number }>({
      name: "price",
      run: async function (ctx) {
        const shopId: string = ctx.input().params.shopId;
        const missing: undefined = ctx.input().result;
        void shopId;
        void missing;
        await ctx.complete({ amount: 100 });
        // @ts-expect-error Saved results use the Step's result type.
        await ctx.complete({ amount: "bad" });
        // @ts-expect-error run has no previous business result.
        ctx.input().result.amount;
        // @ts-expect-error run does not write verdicts.
        await ctx.ok();
      },
      validate: async function (ctx) {
        const amount: number = ctx.input().result.amount;
        const fields: string[] | undefined = ctx.input().params.fields;
        void fields;
        if (amount >= 0) await ctx.ok();
        else await ctx.ng("negative amount");
        // @ts-expect-error Checks cannot overwrite the run result.
        await ctx.complete({ amount: 100 });
        // @ts-expect-error A reason is required.
        await ctx.ng();
      },
      evaluate: async function (ctx) {
        const amount: number = ctx.input().result.amount;
        // @ts-expect-error The result is not an arbitrary shape.
        ctx.input().result.unknownField;
        void amount;
        await ctx.ok();
      },
    });
    this.step({
      name: "untyped",
      run: async function (ctx) {
        await ctx.complete({ arbitrary: true });
      },
    });
  }

  invalidExamples() {
    // @ts-expect-error Expiration is numeric.
    this.configure({ expiresIn: "1000" });
    this.step({
      name: "bad-return",
      // @ts-expect-error Business data is saved, not returned.
      run: async function () {
        return { amount: 1 };
      },
    });
    this.step({
      name: "bad-check",
      run: async function (ctx) {
        await ctx.complete(null);
      },
      // @ts-expect-error Verdicts are saved, not returned.
      validate: async function () {
        return { ok: true };
      },
    });
  }
}

// @ts-expect-error setup() is required even without an override keyword.
class MissingSetup extends Ordo<Env, Params> {}
void MissingSetup;
const handler = TestWorkflow.worker() satisfies ExportedHandler<Env>;
const entrypoint: new (
  ...args: ConstructorParameters<typeof TestWorkflow>
) => WorkflowEntrypoint = TestWorkflow;
void handler;
void entrypoint;

declare const env: Env;
void env.WORKFLOW.create({ params: { goalId: 1 } });
// @ts-expect-error Workflow input is a persisted Goal ID, not business input.
void env.WORKFLOW.create({ params: { shopId: "shop-1" } });
// @ts-expect-error Goal IDs are numeric.
void env.WORKFLOW.create({ params: { goalId: "one" } });
export default TestWorkflow.worker();
