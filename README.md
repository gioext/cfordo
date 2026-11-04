# cfordo

[日本語](README.ja.md)

## Purpose

A TypeScript framework for predefined workflows on Cloudflare Workflows, Queues, and D1.
Business logic, validation, and evaluation run as independent Queue actions. D1 stores their data, verdicts, and progress.
Each dedicated Worker hosts one Ordo class with its own D1, Queue and Workflow. Built-in Hono endpoints start Goals and expose their progress and results.

Changing steps during execution, AI-generated workflow changes, and deployment outside Cloudflare are out of scope.

## Specification

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
`MyWorkflow.worker()` provides both HTTP and Queue entrypoints. Applications do not need their own Hono app or startup handler.

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

Every action reads its input through `ctx.input()`.

| Field    | Description                                                                                                 |
| -------- | ----------------------------------------------------------------------------------------------------------- |
| `params` | Startup parameters saved in D1, typed as `Params`                                                           |
| `result` | The business result saved by the referenced `run`, typed as `Result` in checks and `undefined` during `run` |

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

Use the Node.js and pnpm versions in `mise.toml`. Type checking uses `tsrs`; Cloudflare runtime verification uses Wrangler and Miniflare.
Generate application binding and runtime types with `wrangler types`.

## Development

```sh
mise install
pnpm install --frozen-lockfile
pnpm format
pnpm check
pnpm --filter @cfordo/example typecheck
```

`pnpm format` runs Prettier defaults through `npx` without adding a configuration file or dependency. It respects `.gitignore` and excludes generated types and the lockfile.
`pnpm test` covers types, persistence, retries, resumption, parallel execution, and Workflow/Queue/D1/HTTP integration in the Workers runtime.
Tests do not deploy to Cloudflare or call external AI APIs.
`pnpm build` writes ESM JavaScript, type declarations, and source maps to `dist`.

## Deployment

Publish with `pnpm run deploy` using an account with npm publishing permission. Type checks, tests, and a build run before publication.
Deploy dedicated Workers with Wrangler using the fixed D1, Queue producer/consumer, and Workflow binding names.

Let old Workflow and Queue processing finish before switching. Databases with per-action records can be reused.
Databases from the earlier combined execution format require a reset. The schema is provided as a single initial migration.
