import { Ordo, type OrdoContext } from "cfordo";

export class ExampleWorkflow extends Ordo<Env> {
  async setup() {
    this.binding({
      db: this.env.DB,
      queue: this.env.QUEUE,
      workflow: this.env.WORKFLOW,
    });
    this.configure({
      expiresIn: 24 * 60 * 60 * 1000,
    });
    await this.parallel(this.registerParallel);
  }

  async registerParallel() {
    this.step({
      name: "double",
      run: this.double,
      validate: this.validate,
      evaluate: this.evaluateDouble,
    });
    this.step({
      name: "square",
      run: this.square,
      validate: this.validate,
      evaluate: this.evaluateSquare,
    });
  }

  async double(ctx: OrdoContext) {
    const params = ctx.params<{ value: number }>();
    return { value: params.value * 2 };
  }

  async square(ctx: OrdoContext) {
    return { value: ctx.params().value ** 2 };
  }

  async validate(ctx: OrdoContext) {
    if (!Number.isFinite(ctx.result().value)) return ctx.ng("結果が有限の数値ではありません");
    return ctx.ok();
  }

  async evaluateDouble(ctx: OrdoContext) {
    if (ctx.result().value !== ctx.params().value * 2) return ctx.ng("入力を2倍した結果と一致しません");
    return ctx.ok();
  }

  async evaluateSquare(ctx: OrdoContext) {
    if (ctx.result().value !== ctx.params().value ** 2) return ctx.ng("入力を2乗した結果と一致しません");
    return ctx.ok();
  }
}

export default ExampleWorkflow;
