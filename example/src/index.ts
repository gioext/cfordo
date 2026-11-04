import { Ordo } from "cfordo";

type Params = { value: number };

export class ExampleWorkflow extends Ordo<Env, Params> {
  async setup() {
    this.configure({ expiresIn: 24 * 60 * 60 * 1000 });
    await this.parallel(async () => {
      this.step<{ value: number }>({
        name: "double",
        run: async function (ctx) {
          const { params } = ctx.input();
          await ctx.complete({ value: params.value * 2 });
        },
        validate: async function (ctx) {
          const { result } = ctx.input();
          if (Number.isFinite(result.value)) await ctx.ok();
          else await ctx.ng("結果が有限の数値ではありません");
        },
        evaluate: async function (ctx) {
          const { params, result } = ctx.input();
          if (result.value === params.value * 2) await ctx.ok();
          else await ctx.ng("入力を2倍した結果と一致しません");
        },
      });
      this.step<{ value: number }>({
        name: "square",
        run: async function (ctx) {
          const { params } = ctx.input();
          await ctx.complete({ value: params.value ** 2 });
        },
        validate: async function (ctx) {
          const { result } = ctx.input();
          if (Number.isFinite(result.value)) await ctx.ok();
          else await ctx.ng("結果が有限の数値ではありません");
        },
        evaluate: async function (ctx) {
          const { params, result } = ctx.input();
          if (result.value === params.value ** 2) await ctx.ok();
          else await ctx.ng("入力を2乗した結果と一致しません");
        },
      });
    });
  }
}

export default ExampleWorkflow.worker();
