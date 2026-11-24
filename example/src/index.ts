import { Ordo } from "cfordo";

type Params = { value: number; additionalSquares?: boolean };
type Result = { value: number };

const ordo = new Ordo<Env, Params>();

const double = ordo.step<Result>({
  name: "double",
  run: async (ctx) => ctx.complete({ value: ctx.input().params.value * 2 }),
  validate: async (ctx) =>
    Number.isFinite(ctx.input().result.value) ? ctx.ok() : ctx.ng("非有限"),
  evaluate: async (ctx) =>
    ctx.input().result.value === ctx.input().params.value * 2
      ? ctx.ok()
      : ctx.ng("2倍と不一致"),
});
const square = ordo.step<Result>({
  name: "square",
  run: async (ctx) => ctx.complete({ value: ctx.input().params.value ** 2 }),
  validate: async (ctx) =>
    Number.isFinite(ctx.input().result.value) ? ctx.ok() : ctx.ng("非有限"),
  evaluate: async (ctx) =>
    ctx.input().result.value === ctx.input().params.value ** 2
      ? ctx.ok()
      : ctx.ng("2乗と不一致"),
});

const sum = ordo.step<Result>({
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

const totalSquares = ordo.step<Result, string[]>({
  name: "total-squares",
  run: async (ctx) => {
    const values = await Promise.all(
      ctx.input().params.map((name) => ctx.result<Result>(name)),
    );
    await ctx.complete({
      value: values.reduce((sum, item) => sum + item.value, 0),
    });
  },
});

ordo.plan(async (ctx) => {
  await ctx.parallel([
    ctx.step(double, ctx.input),
    ctx.step(square, ctx.input),
  ]);
  await ctx.step(sum, ctx.input);
  if (ctx.input.additionalSquares) {
    const inputs = await Promise.all(
      ["double", "square"].map((name) => ctx.result<Result>(name)),
    );
    const values = [...new Set(inputs.map((item) => item.value))];
    const name = (value: number) => `square-${value}`;
    await ctx.parallel(
      values.map((value) => ctx.step(name(value), square, { value })),
    );
    await ctx.step(totalSquares, values.map(name));
  }
});

export default ordo;
