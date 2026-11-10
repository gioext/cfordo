import { Ordo } from "cfordo";

type Params = { value: number };
type Result = { value: number };

const ordo = new Ordo<Env, Params>();

await ordo.parallel(async () => {
  ordo.step<Result>({
    name: "double",
    run: async (ctx) => ctx.complete({ value: ctx.input().params.value * 2 }),
    validate: async (ctx) =>
      Number.isFinite(ctx.input().result.value) ? ctx.ok() : ctx.ng("非有限"),
    evaluate: async (ctx) =>
      ctx.input().result.value === ctx.input().params.value * 2
        ? ctx.ok()
        : ctx.ng("2倍と不一致"),
  });
  ordo.step<Result>({
    name: "square",
    run: async (ctx) => ctx.complete({ value: ctx.input().params.value ** 2 }),
    validate: async (ctx) =>
      Number.isFinite(ctx.input().result.value) ? ctx.ok() : ctx.ng("非有限"),
    evaluate: async (ctx) =>
      ctx.input().result.value === ctx.input().params.value ** 2
        ? ctx.ok()
        : ctx.ng("2乗と不一致"),
  });
});

ordo.step<Result>({
  name: "sum",
  run: async (ctx) => {
    const [double, square] = await Promise.all([
      ctx.result<Result>("double"),
      ctx.result<Result>("square"),
    ]);
    await ctx.complete({ value: double.value + square.value });
  },
  validate: async (ctx) =>
    Number.isFinite(ctx.input().result.value) ? ctx.ok() : ctx.ng("非有限"),
  evaluate: async (ctx) => {
    const [double, square] = await Promise.all([
      ctx.result<Result>("double"),
      ctx.result<Result>("square"),
    ]);
    return ctx.input().result.value === double.value + square.value
      ? ctx.ok()
      : ctx.ng("合計が不一致");
  },
});

export default ordo;
