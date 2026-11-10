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
Await persistence operations or return their Promise. Returning business data alone does not save it.
Use unique step names and register steps and settings before processing starts.

| API | Purpose |
| --- | --- |
| `ctx.input().params` | Goal input |
| `ctx.input().result` | The run output being validated or evaluated |
| `await ctx.complete(data)` | Save a run's result |
| `await ctx.ok()` / `await ctx.ng(reason)` | Save a check verdict |
| `await ctx.result<T>(stepName)` | Get a successful step's result in the same Goal |
| `ctx.env` | Bindings, including D1 |
| `ctx.feedback` | Improvement `iteration` and the previous negative verdict's `source` and `reason` |
| `ctx.goalId` / `ctx.stepName` / `ctx.attemptId` | Current Goal, step, and execution identifiers |

Input and results must be JSON-compatible. Non-finite numbers and `undefined` cannot be saved. Use `ctx.complete(null)` when no result is needed.

## Parallel steps and shared results

Steps advance in registration order. Wrap parallel steps in `ordo.parallel()`.
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

This replaces the first `double` definition. The next step starts after every parallel step passes its checks.
`ctx.result()` throws for unfinished or failed steps. See the [example](example/src/index.ts) for validation and evaluation on all three steps.

## Configure improvements and expiration

`configure()` is optional. Call it before processing starts.

```ts
ordo.configure({ maxIterations: 3, expiresIn: 24 * 60 * 60 * 1000 });
```

- `maxIterations`: per-step improvement limit including the initial run; defaults to 3.
- `expiresIn`: Goal lifetime from acceptance, in milliseconds; defaults to 24 hours. Changes also apply to existing unfinished Goals.
- A negative check starts another iteration from run, with its reason available through `ctx.feedback`. Negative validation skips evaluation.
- An exception fails the Goal without automatically rerunning the business operation, including exceptions after saving a result.
- Executions expire 15 minutes after receipt. Unfinished work is rerun after expiration, so external side effects must be idempotent.
- Once a Goal's expiration is finalized, extending the lifetime does not restart it.

## Deploy your Worker

Use one Ordo per dedicated Worker, with its own D1 and Queue.
Name the D1 binding `DB` and the Queue producer binding `QUEUE`. Configure a consumer for that Queue and an every-minute Cron. No DLQ is needed.
Start from the [Wrangler configuration example](example/wrangler.example.jsonc) and supply your resource names and IDs.
Keep `workers_dev: false`, `preview_urls: false`, and `routes: []`; call the Worker through a service binding.

```sh
npx wrangler types
npx wrangler deploy
```

Tables are created automatically. An update that changes the schema version starts with empty tables; old data and unfinished work are not transferred.

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

The service binding selects the destination, not the URL hostname.
POST returns HTTP 202 and a Goal ID without waiting for completion. Each POST creates a new Goal, so handle repeated requests accordingly.
Starting steps, improvement iterations, and subsequent steps waits for scheduled processing.

| Method and path | Response |
| --- | --- |
| `POST /_ordo/goals` | `202 { "goalId": 1 }` |
| `GET /_ordo/goals` | Goals in descending ID order, without execution history |
| `GET /_ordo/goals/:goalId` | Input, status, step results, and execution history |

`status` is `ready`, `running`, `completed`, `failed`, or `expired`. Step results are in `results`; failure information is in `error`.
In-flight and failed outputs are visible, so check for `completed` before accepting results. Detail responses include per-phase history in `executions`.
Invalid JSON or IDs return 400; missing Goals return 404. Business failure still returns HTTP 200 when retrieval succeeds.
