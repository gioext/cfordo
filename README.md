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

const double = ordo.step<{ value: number }>({
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

ordo.plan(async ({ input, step }) => {
  await step(double, input);
});

export default ordo;
```

Use Wrangler-generated binding types for `Env`. `run` is required; `validate` and `evaluate` are optional.

| API                                             | Purpose                                                                           |
| ----------------------------------------------- | --------------------------------------------------------------------------------- |
| `ctx.input().params`                            | Input passed to this step                                                                        |
| `ctx.input().result`                            | The run output being validated or evaluated                                       |
| `await ctx.complete(data)`                      | Save a run's result                                                               |
| `await ctx.ok()` / `await ctx.ng(reason)`       | Save a check verdict                                                              |
| `await ctx.result<T>(stepName)`                 | Get a successful step's result in the same Goal                                   |
| `ctx.env`                                       | Bindings, including D1                                                            |
| `ctx.feedback`                                  | Improvement `iteration` and the previous negative verdict's `source` and `reason` |
| `ctx.goalId` / `ctx.stepName` / `ctx.attemptId` | Current Goal, step, and execution identifiers                                     |

## Dynamic sequential and parallel steps

Replace the plan above to select subsequent steps from a completed result.

```ts
ordo.plan(async ctx => {
  await ctx.step(double, ctx.input);
  const first = await ctx.result<{ value: number }>("double");
  if (first.value > 10) {
    await ctx.parallel([first.value, first.value + 1].map(value =>
      ctx.step(`double-${value}`, double, { value })
    ));
    const next = await ctx.result<{ value: number }>(`double-${first.value}`);
    // ...
  }
});
```

Register one callback per workflow. The planner evaluates it from the beginning on each advance and yields at pending steps. Both `await ctx.step()` and `await ctx.parallel()` return void. In the plan and in Worker handlers, use `await ctx.result(name)` to read the completed result in the same Goal. An unknown or incomplete step raises an error.

Use `step(name, definition, params)` to give each target a unique name within the Goal. Omitting the name uses the registered definition name. Calls with the same name refer to the same work. Use a different name when a target needs fresh processing. Arguments must be JSON values. The plan may read current data via `ctx.env`. Put side effects in Worker handlers and let step exceptions propagate from the plan.

When migrating from 0.6.0, replace uses of step return values with `ctx.result()` and explicitly name steps with individual arguments. Finish Goals using the old plan before changing step names, as a new name identifies different work.

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
