# cfordo

[日本語](README.ja.md)

## Purpose

A TypeScript framework for predefined workflows on Cloudflare Workflows, Queues, and D1.
Business logic, validation, and evaluation run as independent Queue actions. D1 stores their data, verdicts, and progress.
Each dedicated Worker hosts one Ordo class with its own D1, Queue and Workflow. Built-in Hono endpoints start Goals and expose progress and results over a private service binding. No public URL is used.

Changing steps during execution, AI-generated workflow changes, and deployment outside Cloudflare are out of scope.

## Specification

### Independent steps and D1

Each step executes independently, reads the data it needs from D1, and saves its results to D1.
Execution order does not pass one step's return value into another. Do not rely on shared class fields, variables, or closures to carry data between steps.
Even sequential steps exchange data through persisted records. Independent execution and data access still allow a step to wait for earlier steps to finish.

- Startup input is saved with the Goal in D1 and is available to each action as `ctx.input().params`.
- `ctx.complete(data)` saves that execution's result to D1. In validation and evaluation, `ctx.input().result` is the saved result of the referenced run in the same step.
- A step that needs another step's result queries D1 using the Goal ID and step name or another explicit key. Other steps' results are not automatically placed in `ctx.input().result`.

The [runnable example](example/src/index.ts) starts double and square in parallel for `{ "value": 7 }`, then runs sum after both finish.
Double saves 14 and square saves 49 to D1. Sum uses SQL to read both results for the same Goal and saves 63. Validation checks that the result is a finite number. Evaluation derives the expectation from that Goal's input or saved D1 results. Sum's evaluation independently reads both D1 results again.

### Usage

```ts
import { Ordo } from "cfordo";

type Params = { value: number };

export class MyWorkflow extends Ordo<Env, Params> {
  async setup() {
    this.configure({ expiresIn: 24 * 60 * 60 * 1000 });
    this.step<{ value: number }>({
      name: "calculate",
      run: async function (ctx) {
        const { params } = ctx.input();
        await ctx.complete({ value: params.value * 2 });
      },
      validate: async function (ctx) {
        const { result } = ctx.input();
        if (Number.isFinite(result.value)) await ctx.ok();
        else await ctx.ng("The result is not a finite number");
      },
      evaluate: async function (ctx) {
        const { params, result } = ctx.input();
        if (result.value === params.value * 2) await ctx.ok();
        else await ctx.ng("The result does not equal twice the input");
      },
    });
  }
}

export default MyWorkflow.worker();
```

Use Wrangler's generated binding types for `Env`. Set Wrangler's `class_name` to the named Workflow export: `MyWorkflow` in this example.
`MyWorkflow.worker()` provides the service-binding HTTP entrypoint and Queue handler. Applications do not need their own Hono app or startup handler.

### Service binding

Configure the Ordo Worker with `workers_dev: false`, `preview_urls: false`, and `routes: []`. Do not assign public routes or custom domains.
The calling Worker declares a service binding to the deployed Ordo Worker's name:

```json
{ "services": [{ "binding": "ORDO", "service": "example-ordo" }] }
```

Declare `ORDO: Fetcher` in the caller's `Env`.

```ts
const response = await env.ORDO.fetch("https://ordo/_ordo/goals", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ value: 7 }),
});
const { goalId } = await response.json<{ goalId: number }>();
const detail = await env.ORDO.fetch(`https://ordo/_ordo/goals/${goalId}`);
const list = await env.ORDO.fetch("https://ordo/_ordo/goals");
```

The URL is required to construct a Request; it is not a public endpoint and needs no DNS configuration. The binding selects the destination Worker.

### Goal API

| Method and path            | Input                    | Response                                             |
| -------------------------- | ------------------------ | ---------------------------------------------------- |
| `POST /_ordo/goals`        | Business input as JSON   | `202 { "goalId": 1 }` and a `Location` header        |
| `GET /_ordo/goals`         | None                     | All Goals in descending ID order, without pagination |
| `GET /_ordo/goals/:goalId` | Positive integer Goal ID | One Goal with results and execution history          |

Goal IDs are allocated before the Workflow starts and are distinct from Workflow instance IDs. Use the numeric Goal ID for subsequent queries.
POST does not wait for completion. Repeated POST requests create separate Goals. Poll the returned IDs to aggregate concurrent runs.

Both list and detail responses contain `goalId`, `input`, `status`, `createdAt`, `expiresAt`, `finishedAt`, `error`, and `results`.
Goal status is `ready`, `running`, `completed`, `failed`, or `expired`. Dates are Unix epoch milliseconds; an unobserved finish time is `null`.
`results` is an array of steps with `stepName`, `status`, `action`, `output`, `validation`, `evaluation`, `error`, `createdAt`, and `finishedAt`.
Steps that have not started are included. `action` names the current or next action and is `null` after completion. Steps may also be `expired`.
Output and verdicts always refer to the same run; a rerun does not inherit an earlier run's checks. Missing output or verdicts are `null`.
In-flight or failed output may be visible; only accept a step's result after its status is `completed`.

Detail responses additionally include `executions` for each step, ordered by execution ID. Each entry represents one queued action, not one delivery.
Entries contain `attemptId`, `action`, `sourceRunId`, `status`, `output`, `verdict`, `error`, `createdAt`, and `finishedAt`.
`action` is `run`, `validate`, or `evaluate`. `sourceRunId` identifies the checked run and is `null` for a run itself.
Verdicts are `{ "ok": true }` or `{ "ok": false, "reason": "..." }`, or `null` before a verdict is saved.
Queue redelivery does not add an execution; business retries do.

Errors use `{ "code": "...", "message": "..." }`, or `null` when absent.
Invalid JSON or IDs return `400`, missing Goals return `404`, unexpected errors return `500`, and unavailable Workflow startup/status confirmation returns `503`.
HTTP errors use `{ "error": { "code": "...", "message": "..." } }`. A startup error after saving a Goal also includes `goalId`.
A rejected creation request may still have started the Workflow: query that Goal before starting another. The deadline also applies to Goals that never start.
Business failure and expiration still return HTTP `200` when the query succeeds. Platform termination is reflected in the view; a status-query failure is not a business failure.

### Initialization, bindings, and settings

`setup()` is a required asynchronous method. TypeScript detects a missing implementation; `override` is not required.
It runs once per instance after class fields are initialized and before processing starts. Concurrent initialization requests share that setup.
Register settings and steps in `setup()`. Put business side effects in the actions.

Binding names are fixed: `DB` for D1, `QUEUE` for the dedicated Queue, and `WORKFLOW` for this Ordo class.
`Env` must satisfy the public `OrdoEnv` type. Additional business bindings are supported.

`this.configure()` is optional.

| Key         | Purpose                                                               |
| ----------- | --------------------------------------------------------------------- |
| `expiresIn` | Goal lifetime in positive integer milliseconds. Defaults to 24 hours. |

Registration does not access D1 or send Queue messages. Processing starts only after successful initialization. Settings and registrations cannot change after execution starts.

### Steps and types

Pass one step definition to `this.step<Result>()`.

| Key        | Required | Purpose                                                                                   |
| ---------- | -------- | ----------------------------------------------------------------------------------------- |
| `name`     | Yes      | Step name                                                                                 |
| `run`      | Yes      | Business logic; saves its result with `await ctx.complete(data)`                          |
| `validate` | No       | Business-rule validation; saves a verdict with `await ctx.ok()` or `await ctx.ng(reason)` |
| `evaluate` | No       | Result evaluation; saves a verdict with `await ctx.ok()` or `await ctx.ng(reason)`        |

All actions are asynchronous and return no data. Callback return values are not saved, passed between actions, or used for progress decisions.
Provided actions run in the order `run`, `validate`, `evaluate`, as separate Queue executions. Omitted checks are skipped.
After each action, D1 records determine what happens next. Business results and verdicts are not passed through Workflow step returns or notification payloads.

`Params` types the business JSON accepted by HTTP and read by actions. Start Workflows through the Ordo API.
`Result` types one step's business data, both when saving through `ctx.complete()` and when reading it in checks. Type arguments are optional and default to `any`.
These are static types, not runtime business-schema validation. Neither Zod nor Standard Schema is required.

Registered methods and `parallel()` callbacks are bound to their Ordo instance; callers do not need `.bind(this)`.
Methods can be reused by multiple steps. There is no separate Worker registration or string reference to a business handler.

### Parallel execution

Ordinary steps run in registration order. Steps registered inside `this.parallel()` advance concurrently.

```ts
await this.parallel(async () => {
  this.step<{ value: number }>({
    name: "double",
    run: async function (ctx) {
      await ctx.complete({ value: ctx.input().params.value * 2 });
    },
  });
  this.step<{ value: number }>({
    name: "square",
    run: async function (ctx) {
      await ctx.complete({ value: ctx.input().params.value ** 2 });
    },
  });
});
```

The next group starts only when every required action in every current step has passed. Retrying one step does not rerun successful siblings.
Duplicate names, empty parallel groups, and nested parallel groups are not allowed. Await asynchronous registration in `setup()`.

### Input and persistence

Before each action starts, Ordo reads the saved Goal input and referenced run result from D1. `ctx.input()` returns those values for that action.
An action that needs another step's result or application-table data queries it directly through `this.env.DB`.

| Field    | Description                                                                                                                        |
| -------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `params` | Startup parameters saved in D1, typed as `Params`                                                                                  |
| `result` | The saved result of the referenced `run` in the same step, not the preceding step; `Result` in checks and `undefined` during `run` |

Check retries refer to the same successful run, rather than switching to an unrelated latest result.
Modifying retrieved values does not change the saved input or business result.

| API or value               | Description                                                         |
| -------------------------- | ------------------------------------------------------------------- |
| `await ctx.complete(data)` | Saves business data; available to `run`                             |
| `await ctx.ok()`           | Saves an OK verdict; available to checks, with no arguments         |
| `await ctx.ng(reason)`     | Saves an NG verdict and a non-blank reason; available to checks     |
| `ctx.goalId`               | Goal ID                                                             |
| `ctx.stepName`             | Step name                                                           |
| `ctx.attemptId`            | ID of this action execution                                         |
| `ctx.feedback`             | Previous negative verdict as `{ source, reason }`; absent initially |

All persistence methods return `Promise<void>` and must be awaited. Repeated writes to the same running execution overwrite its previous value.
A save alone does not advance the workflow. **The required outcome must be saved in D1 and the function must finish successfully before the execution is finalized and notified.**
An exception after saving still fails that execution. Finalized records cannot be changed.

Inputs and business results must be JSON-compatible. Use `await ctx.complete(null)` when no result is needed.
Values such as `undefined`, circular references, and non-finite numbers cannot be stored. Finishing without saving an outcome also records a failure through the common exception path.
An NG verdict is not an exception. The check execution completes after saving its verdict and finishing normally; its saved negative verdict determines whether the business step runs again.

### Retries, resumption, and termination

- An exception retries only the failed action, using a new execution record.
- A negative validation or evaluation verdict restarts from a new `run`, carrying its reason as feedback.
- Across a Goal and step, the fixed limits are 3 exception failures, 3 validation NGs, and 10 evaluation NGs, including the initial attempt. Counts are not reset by reruns.
- Saving data without successfully finishing the action does not count as success.
- Redelivery after a completed or failed execution only sends its notification again; it does not rerun that execution.
- An uncertain in-flight execution is not automatically rerun. Precise crash recovery is not guaranteed; such runs are left to platform failure or expiration.

A common exception path records failures in D1. Execution ID, step, action, timestamps, error type, message, and any available stack identify what failed.
If even failure recording is unavailable, or notification fails, the Queue platform handles redelivery. No custom automatic recovery mechanism is added.

One Workflow instance maps to one Goal. Resumption reloads that Goal and its progress from D1.
Restarting the same instance retains its original input and terminal state. Start a new Goal through the API for a new business run.
Workflow step return values and in-memory variables are not used as resumption state.

Query the Goal API for business status. The Workflow no longer returns `completed`, `failed`, or `expired` as its final output.
Successful platform completion means orchestration finished, not necessarily that the business Goal succeeded. A failed business Goal can therefore have a normally completed Workflow.

Expiration is fixed when the HTTP request creates the Goal and is not extended by retries. It is derived from the saved deadline and the current time, without a database update solely to mark expiration.
No new actions start after expiration is detected. Already-running business logic is not guaranteed to stop at the exact deadline, and late results may be retained as history.

The management database is initialized and migrated automatically before processing. Call `initOrdo(env.DB)` for explicit initialization.

## Development environment

Use the Node.js and pnpm versions in `mise.toml`. Type checking uses `tsrs`. Verify behavior against the production example deployed with Wrangler.
Generate application binding and runtime types with `wrangler types`.

## Development

```sh
mise install
pnpm install --frozen-lockfile
pnpm format
pnpm check
```

`pnpm format` runs Prettier defaults through `npx` without adding a configuration file or dependency. It respects `.gitignore` and excludes generated types and the lockfile.
`pnpm check` checks library types, builds the package, and checks example types. Local checks alone do not complete behavioral verification.
Verify the production example through a service binding using the [example instructions](example/README.md).
`pnpm build` writes ESM JavaScript, type declarations, and source maps to `dist`.

## Deployment

Publish with `pnpm run deploy` using an account with npm publishing permission. Complete `pnpm check` and behavioral verification of the production example before publication.
Deploy dedicated Workers with Wrangler using the fixed D1, Queue producer/consumer, and Workflow binding names.
Disable public URLs and use a service binding from the calling Worker. Keep the example's real account/database IDs in its ignored local configuration.

Let old Workflow and Queue processing finish before switching. Databases with per-action records can be reused.
Databases from the earlier combined execution format require a reset. The schema is provided as a single initial migration.
