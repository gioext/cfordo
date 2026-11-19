# cfordo

[日本語](README.ja.md)

A TypeScript library for jobs combining execution, validation, and evaluation on Cloudflare Workers, Queues, and D1.

## Install

```sh
pnpm add cfordo
```

## Define a step

```ts
import { Ordo } from "cfordo";

type Params = { value: number };
const ordo = new Ordo<Env, Params>();

ordo.step<{ value: number }>({
  name: "double",
  run: async (ctx) => ctx.complete({ value: ctx.input().params.value * 2 }),
  validate: async (ctx) =>
    Number.isFinite(ctx.input().result.value)
      ? ctx.ok()
      : ctx.ng("Non-finite result"),
  evaluate: async (ctx) =>
    ctx.input().result.value === ctx.input().params.value * 2
      ? ctx.ok()
      : ctx.ng("Does not equal twice the input"),
});

export default ordo;
```

Use Wrangler-generated binding types for `Env`. `run` is required; `validate` and `evaluate` are optional.

| API                                             | Purpose                                                                           |
| ----------------------------------------------- | --------------------------------------------------------------------------------- |
| `ctx.input().params`                            | Goal input                                                                        |
| `ctx.input().result`                            | The run output being validated or evaluated                                       |
| `await ctx.complete(data)`                      | Save a run's result                                                               |
| `await ctx.ok()` / `await ctx.ng(reason)`       | Save a check verdict                                                              |
| `await ctx.result<T>(stepName)`                 | Get a successful step's result in the same Goal                                   |
| `ctx.env`                                       | Bindings, including D1                                                            |
| `ctx.feedback`                                  | Improvement `iteration` and the previous negative verdict's `source` and `reason` |
| `ctx.goalId` / `ctx.stepName` / `ctx.attemptId` | Current Goal, step, and execution identifiers                                     |

## Parallel steps and shared results

Wrap parallel steps in `ordo.parallel()`.
Use `ctx.result()` to obtain prior steps' results instead of sharing variables or return values.

```ts
await ordo.parallel(async () => {
  ordo.step<{ value: number }>({
    name: "double",
    run: async (ctx) => ctx.complete({ value: ctx.input().params.value * 2 }),
  });
  ordo.step<{ value: number }>({
    name: "square",
    run: async (ctx) => ctx.complete({ value: ctx.input().params.value ** 2 }),
  });
});

ordo.step<{ value: number }>({
  name: "sum",
  run: async (ctx) => {
    const [double, square] = await Promise.all([
      ctx.result<{ value: number }>("double"),
      ctx.result<{ value: number }>("square"),
    ]);
    await ctx.complete({ value: double.value + square.value });
  },
});
```

This replaces the first `double` definition. See the [example](example/src/index.ts) for validation and evaluation on all three steps.

## Configure improvements and expiration

`configure()` is optional. Call it before processing starts.

```ts
ordo.configure({ maxIterations: 3, expiresIn: 24 * 60 * 60 * 1000 });
```

- `maxIterations`: improvement iteration limit per step.
- `expiresIn`: Goal lifetime in milliseconds.

## Deploy your Worker

Use one Ordo per dedicated Worker, with its own Queue. Workers may share D1 when each uses a different `workflow`.
Name the D1 binding `DB` and the Queue producer binding `QUEUE`. Configure a consumer for that Queue and an every-minute Cron.
Start from the [Wrangler configuration example](example/wrangler.example.jsonc) and supply your resource names and IDs.
Keep `workers_dev: false`, `preview_urls: false`, and `routes: []`; call the Worker through a service binding.

```sh
npx wrangler types
npx wrangler deploy
```

## Start and read Goals

Configure a service binding on the calling Worker. Set `service` to your deployed Worker name.

```json
{ "services": [{ "binding": "ORDO", "service": "example-ordo" }] }
```

```ts
const response = await env.ORDO.fetch("https://ordo/_ordo/goals", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ value: 7 }),
});
const { goalId } = await response.json<{ goalId: number }>();
const detail = await env.ORDO.fetch(`https://ordo/_ordo/goals/${goalId}`);
```

| Method and path                  | Response                                                        |
| -------------------------------- | --------------------------------------------------------------- |
| `POST /_ordo/goals`              | `202 { "goalId": 1 }`                                           |
| `GET /_ordo/goals`               | Goals in descending ID order, without execution history         |
| `GET /_ordo/goals/:goalId`       | Input, status, step results, and execution history              |
| `POST /_ordo/goals/:goalId/stop` | `200` with the current Goal detail, including execution history |

## Stop a Goal

```ts
await env.ORDO.fetch(`https://ordo/_ordo/goals/${goalId}/stop`, { method: "POST" });
```
