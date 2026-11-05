# cfordo

[日本語](README.ja.md)

## Purpose

A TypeScript framework for predefined jobs on Cloudflare Cron Triggers, Queues, and D1.
Each Queue invocation executes one improvement iteration: run, validate, then evaluate. D1 stores input, results, verdicts, iterations, and progress.
Each dedicated Worker hosts one Ordo with its own D1 and Queue. Access its HTTP API over a private service binding; no public URL is required.

Changing steps during execution, AI-generated steps, and deployment outside Cloudflare are out of scope.

## Specification

### Usage

```ts
import { Ordo } from "cfordo";

type Params = { value: number };
const ordo = new Ordo<Env, Params>();
ordo.configure({ deadLetterQueue: "example-ordo-queue-dlq" });

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

Use Wrangler-generated binding types for `Env`. No subclass, `setup()`, or `.worker()` is needed.
The default export provides HTTP, Queue, and Cron entrypoints. Applications do not need a separate Hono app or startup handler.

### Startup and progress

Starting a Goal persists its input in D1 and returns HTTP 202 with a numeric Goal ID. POST does not wait for completion; each POST creates a separate Goal.
A permanent every-minute Cron checks unfinished Goals. When none exist, there is no work to perform.
Run, validate, and evaluate execute consecutively within an iteration. Only the next improvement iteration or following step waits for another Cron invocation.
Queue actions save results and finish independently. They neither schedule successors nor send completion notifications.

### Steps and parallel execution

Pass a definition to `ordo.step<Result>()`:

| Key        | Required | Purpose                                                                      |
| ---------- | -------- | ---------------------------------------------------------------------------- |
| `name`     | Yes      | Unique step name                                                             |
| `run`      | Yes      | Business logic; save the outcome with `ctx.complete(data)`                   |
| `validate` | No       | Business-rule validation; save a verdict with `ctx.ok()` or `ctx.ng(reason)` |
| `evaluate` | No       | Result evaluation; save a verdict with `ctx.ok()` or `ctx.ng(reason)`        |

All handlers are asynchronous. Await persistence operations or return their Promise. Returning business data does not save it.
One Queue invocation executes one iteration in run → validate → evaluate order, using the same context object. Omitted checks are skipped; a negative validation also skips evaluation.
Steps advance in registration order, after all required checks on the preceding step succeed.

Steps registered inside `ordo.parallel()` advance concurrently. Awaiting registration is distinct from waiting for execution to finish.

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

A subsequent group starts only after every step in the current group passes. Retrying one step does not rerun successful siblings.
Duplicate names, empty groups, and nested parallel groups are rejected. Registrations and settings cannot change after processing starts.
The [complete example](example/src/index.ts) includes validation and evaluation for all three steps.

### Input, results, and bindings

Between steps, obtain data from D1 rather than shared variables, closures, or return values. The handlers within one iteration share a context.
At the start of each iteration, Ordo loads the Goal input and previous iteration's feedback from D1. Checks read the result saved by the run in this iteration.

| API or value                    | Purpose                                                                                   |
| ------------------------------- | ----------------------------------------------------------------------------------------- |
| `ctx.input().params`            | This Goal's startup input, typed as `Params`                                              |
| `ctx.input().result`            | The referenced run's saved result in checks, typed as `Result`; `undefined` in run        |
| `await ctx.result<T>(stepName)` | Read the entire saved output of a successfully completed step in the same Goal from D1    |
| `ctx.env`                       | Bindings for this invocation, including `ctx.env.DB` and any application bindings         |
| `await ctx.complete(data)`      | Save a run's business result                                                              |
| `await ctx.ok()`                | Save a successful check verdict; takes no arguments                                       |
| `await ctx.ng(reason)`          | Save a negative verdict with a non-blank reason                                           |
| `ctx.goalId`                    | Goal ID                                                                                   |
| `ctx.stepName`                  | Current step name                                                                         |
| `ctx.attemptId`                 | Current phase execution record ID; changes between phases on the shared context           |
| `ctx.feedback`                  | `{ iteration, source, reason }`; initially `{ iteration: 1, source: null, reason: null }` |

`ctx.result()` rejects unregistered, unstarted, unfinished, and failed steps. A successful run alone is insufficient when required checks remain.
No explicit Goal ID is needed, and results from different Goals cannot mix. Applications need not know Ordo's table layout.
Mutating a retrieved value does not change stored data. Feedback is fixed within an iteration. A new improvement iteration or Queue retry reconstructs its context from D1.

Binding names are fixed: `DB` for D1 and `QUEUE` for the dedicated Queue. `Env` must satisfy `OrdoEnv`; additional application bindings are supported.
Specify the native dead-letter queue consumed by this Worker with `configure({ deadLetterQueue })`. Queue retry counts and delays are managed only in the Wrangler consumer configuration.
Type arguments provide static types, not runtime business-schema validation. Omitted input and result types default to `any`.

### Persistence, improvement loops, and exception retries

Inputs and business results must be JSON-compatible. Undefined values, non-finite numbers, and cycles cannot be saved. Use `ctx.complete(null)` when no result is needed.
A phase completes after saving its required outcome and returning successfully. An exception after saving is still recorded as a failure. Every re-execution must save its own outcome.

- A negative validation or evaluation ends the current iteration normally after saving its results. A negative verdict is not an exception.
- The next Cron invocation starts another iteration, increments `ctx.feedback.iteration`, and supplies the negative verdict through `source` and `reason`.
- The improvement limit is 10 iterations including the initial iteration, shared by validation and evaluation. Passing on iteration 10 succeeds; a negative verdict on iteration 10 fails the Goal for unmet quality.
- Exceptions use Queue retries to restart the same iteration from run. Previously successful phases can execute again; external side effects must be idempotent.
- Queue retries do not change the iteration number or previous iteration's feedback. Exceptions do not consume improvement iterations.
- Cron does not resend queued, running, or retrying iterations. Failed sends can be retried by Cron; an interrupted send becomes eligible after its one-minute send-confirmation deadline.
- Redelivery of a finalized iteration neither executes its handlers nor changes its results.
- Messages that exhaust Queue retries are handled by the native DLQ and recorded as `QueueRetriesExhausted` in D1. Cron does not reset the Queue retry budget by sending a new message.

History preserves phases from each Queue execution. `executions.iteration` identifies the improvement iteration and `delivery` identifies the Queue delivery attempt. These fields are omitted on historical records from the earlier format.
Successful example Goals still have three records per step and nine in total. An iteration rejected by validation has no evaluation record.

Expiration is fixed at acceptance and never extended by improvement or retries. The default is 24 hours; change it with `ordo.configure({ deadLetterQueue: "...", expiresIn: milliseconds })`.
No new phases start after expiration. Already-running code is not guaranteed to stop at that exact instant, and late results may remain in history.

### Goal API

| Method and path            | Input               | Response                                             |
| -------------------------- | ------------------- | ---------------------------------------------------- |
| `POST /_ordo/goals`        | Business input JSON | `202 { "goalId": 1 }` and a `Location` header        |
| `GET /_ordo/goals`         | None                | All Goals in descending ID order, without pagination |
| `GET /_ordo/goals/:goalId` | Positive integer ID | One Goal with results and execution history          |

Common fields are `goalId`, `input`, `status`, `createdAt`, `expiresAt`, `finishedAt`, `error`, and `results`.
Status is `ready`, `running`, `completed`, `failed`, or `expired`. Dates are Unix epoch milliseconds; an unobserved finish time is `null`.
Each result contains `stepName`, `status`, `action`, `output`, `validation`, `evaluation`, `error`, `createdAt`, and `finishedAt`. Unstarted steps are included.
`action` identifies the current or next action and is `null` after step completion. Output and verdicts refer to the same run; missing values are `null`.
In-flight and failed outputs can be visible. Only accept a step's result when its status is `completed`.

Only detail responses contain `executions`, ordered by execution record ID. List responses omit them.
Entries contain `attemptId`, `action`, `sourceRunId`, `status`, `output`, `verdict`, `error`, `createdAt`, and `finishedAt`.
`sourceRunId` identifies the checked run and is `null` for run itself. Verdicts are `{ "ok": true }` or `{ "ok": false, "reason": "..." }`.
Errors are `{ "code": "...", "message": "..." }`, or `null` when absent.

Invalid JSON or IDs return HTTP 400, missing Goals return 404, and unexpected infrastructure errors return 500.
Business failure or expiration still returns HTTP 200 when the query succeeds; inspect `status` and `error`.
A lost startup response may leave a saved Goal. Repeating POST creates another Goal.

## Development environment

Use Node.js and pnpm from `mise.toml`, `tsrs` for type checking, and Wrangler for deployment.
Generate application binding and runtime types with `wrangler types`.

## Development

```sh
mise install
pnpm install --frozen-lockfile
pnpm format
pnpm check
```

`pnpm check` checks library types, builds the library, and checks example types.
Local checks are limited to type checking and builds. Verify behavior with the [production example instructions](example/README.md).
`pnpm build` emits ESM, declarations, and source maps to `dist`.

## Deployment

Publish with `pnpm run deploy` using an account with npm publishing permission, after production example verification completes.
Configure each application Worker with D1, a Queue producer/consumer, a native DLQ, and an every-minute Cron. The same Worker consumes the DLQ; pass its name to `configure({ deadLetterQueue })`:

```json
{
  "queues": {
    "consumers": [
      {
        "queue": "example-ordo-queue",
        "max_retries": 3,
        "dead_letter_queue": "example-ordo-queue-dlq"
      },
      { "queue": "example-ordo-queue-dlq" }
    ]
  },
  "triggers": { "crons": ["* * * * *"] }
}
```

Keep the Cron configured permanently. Adding, changing, or removing its schedule may take time to propagate across Cloudflare.
Disable public access with `workers_dev: false`, `preview_urls: false`, and `routes: []`.
The calling Worker declares a service binding:

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

The URL is used to construct a Request; the binding selects the destination. No public domain or DNS configuration is needed.
Ordo initializes and migrates the database automatically. Explicit initialization is available through `initOrdo(env.DB)`.
Before migrating an old deployment, confirm its old Workflow and Queue processing has finished.
Existing per-action databases and history are preserved; no database reset is required.
