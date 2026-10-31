import { Ordo, type OrdoContext } from "cfordo";
import type { WorkflowEntrypoint } from "cloudflare:workers";

interface Env { DB: D1Database; JOBS: Queue; FLOW: Workflow }

export class TestWorkflow extends Ordo<Env> {
  async setup() {
    this.binding({ db: this.env.DB, queue: this.env.JOBS, workflow: this.env.FLOW });
    this.configure({ expiresIn: 1000 });
    this.step({ name: "price", run: this.extract, validate: this.check, evaluate: this.check });
  }

  async extract(ctx: OrdoContext) {
    const params = ctx.params<{ shopId: string }>();
    const shopId: string = params.shopId;
    const id: number = ctx.attemptId;
    const unrestricted = ctx.params().anything;
    void id; void unrestricted;
    return { amount: 100, shopId: shopId };
  }

  async check(ctx: OrdoContext) {
    const amount: number = ctx.result<{ amount: number }>().amount;
    return amount >= 0 ? ctx.ok() : ctx.ng("negative amount");
  }

  invalidExamples() {
    // @ts-expect-error All three bindings are required.
    this.binding({ db: this.env.DB, queue: this.env.JOBS });
    // @ts-expect-error Expiration is a number.
    this.configure({ expiresIn: "1000" });
    // @ts-expect-error Binding settings belong to binding().
    this.configure({ db: this.env.DB });
    // @ts-expect-error Arbitrary check results are not accepted.
    this.step({ name: "bad-check", run: this.extract, evaluate: async () => ({ ok: true }) });
    // @ts-expect-error Functions must be asynchronous.
    this.step({ name: "sync", run: () => ({ amount: 1 }) });
    // @ts-expect-error Output schemas are not part of the public API.
    this.step({ name: "schema", run: this.extract, output: {} });
    // @ts-expect-error A separate Worker registration is no longer needed.
    this.worker({ name: "old", run: this.extract });
    // @ts-expect-error Steps take functions, not Worker names.
    this.step({ name: "old", worker: "price" });
  }
}

// @ts-expect-error setup() is mandatory, without requiring an override keyword.
class MissingSetup extends Ordo<Env> {}
void MissingSetup;
const handler = { queue: TestWorkflow.queue() } satisfies ExportedHandler<Env>;
const entrypoint: new (...args: ConstructorParameters<typeof TestWorkflow>) => WorkflowEntrypoint = TestWorkflow;
void handler; void entrypoint;

function checkArguments(ctx: OrdoContext) {
  // @ts-expect-error ok() does not accept business output.
  ctx.ok({ amount: 1 });
  // @ts-expect-error ng() requires a reason.
  ctx.ng();
  // @ts-expect-error Explicit retrieval types are respected.
  const invalid: string = ctx.params<{ amount: number }>().amount;
  void invalid;
}
void checkArguments;
type GeneratedWorkflowParams = Parameters<import("./consumer.js").TestWorkflow["run"]>[0]["payload"];
declare const generatedParams: GeneratedWorkflowParams;
void generatedParams;
export default TestWorkflow;
