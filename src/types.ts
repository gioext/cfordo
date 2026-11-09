export type JsonValue =
  null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
export type GoalStatus = "ready" | "running" | "completed" | "failed";
export type EffectiveGoalStatus = GoalStatus | "expired";
export type Action = "run" | "validate" | "evaluate";
export type CheckSource = Exclude<Action, "run">;
export type AttemptStatus = "ready" | "running" | "completed" | "failed";

export interface OrdoContext<
  Params = any,
  Result = any,
  Phase extends Action = Action,
  Env extends OrdoEnv = OrdoEnv,
> {
  readonly env: Env;
  input(): { params: Params; result: Phase extends "run" ? undefined : Result };
  result<T = any>(stepName: string): Promise<T>;
  complete: Phase extends "run" ? (value: Result) => Promise<void> : never;
  ok: Phase extends "run" ? never : () => Promise<void>;
  ng: Phase extends "run" ? never : (reason: string) => Promise<void>;
  readonly goalId: number;
  readonly stepName: string;
  readonly attemptId: number;
  readonly feedback: ImprovementFeedback;
}

export type CheckFunction<
  Params = any,
  Result = any,
  Env extends OrdoEnv = OrdoEnv,
> = (ctx: OrdoContext<Params, Result, CheckSource, Env>) => Promise<void>;

export interface StepDefinition<
  Params = any,
  Result = any,
  Env extends OrdoEnv = OrdoEnv,
> {
  name: string;
  run(ctx: OrdoContext<Params, Result, "run", Env>): Promise<void>;
  validate?: CheckFunction<Params, Result, Env>;
  evaluate?: CheckFunction<Params, Result, Env>;
}

// Only the structural subset used by cfordo is required of Cloudflare bindings.
export interface DatabaseResult<Row = Record<string, unknown>> {
  success: boolean;
  results?: Row[];
  meta: { changes?: number; last_row_id?: number };
  error?: string;
}

export interface DatabaseStatement {
  bind(...values: unknown[]): DatabaseStatement;
  first<Row = Record<string, unknown>>(column?: string): Promise<Row | null>;
  all<Row = Record<string, unknown>>(): Promise<DatabaseResult<Row>>;
  run<Row = Record<string, unknown>>(): Promise<DatabaseResult<Row>>;
}

export interface DatabaseBinding {
  prepare(sql: string): DatabaseStatement;
  batch<Row = unknown>(
    statements: DatabaseStatement[],
  ): Promise<DatabaseResult<Row>[]>;
}

export interface OrdoEnv {
  DB: D1Database;
  QUEUE: Queue;
}

export interface ImprovementFeedback {
  readonly iteration: number;
  readonly source: CheckSource | null;
  readonly reason: string | null;
}

export interface OrdoOptions {
  /** Name of the native dead-letter queue consumed by this Worker. */
  deadLetterQueue: string;
  /** Goal lifetime in milliseconds; defaults to 24 hours. */
  expiresIn?: number;
}

export interface OrdoRegistration<Params = any, Env extends OrdoEnv = OrdoEnv> {
  configure(options: OrdoOptions): void;
  step<Result = any>(definition: StepDefinition<Params, Result, Env>): void;
  parallel(callback: () => Promise<void>): Promise<void>;
}

// Internal records and protocol. They are not re-exported by the package entrypoint.
/** Persisted check records, never accepted directly from user callbacks. */
export type CheckResult = { ok: true } | { ok: false; reason: string };

export interface Goal {
  id: number;
  input: JsonValue;
  error: AttemptError | null;
  status: GoalStatus;
  createdAt: number;
  expiresAt: number;
  finishedAt: number | null;
}

export type ErrorSource =
  "run" | CheckSource | "dispatch" | "configuration" | "queue";
export interface AttemptError {
  source: ErrorSource;
  name: string;
  message: string;
  stack?: string;
}

export interface Iteration {
  id: number;
  goalId: number;
  stepName: string;
  iteration: number;
  dispatchStatus: "ready" | "sending" | "queued";
  createdAt: number;
}

/** Projection of a final execution record in the shared history table. */
export interface IterationResult {
  id: number;
  iterationId: number;
  attemptId: number | null;
  error: AttemptError | null;
  finishedAt: number;
}

export interface Attempt {
  id: number;
  iterationId: number | null;
  iteration: number | null;
  delivery: number | null;
  dispatchToken: string | null;
  goalId: number;
  stepName: string;
  action: Action | null;
  predecessorId: number | null;
  sourceRunId: number | null;
  status: AttemptStatus;
  output: JsonValue | undefined;
  validation: CheckResult | null;
  evaluation: CheckResult | null;
  error: AttemptError | null;
  createdAt: number;
  finishedAt: number | null;
}

export type RegisteredStep<Env extends OrdoEnv = any> = StepDefinition<
  any,
  any,
  Env
>;
export type Playbook<Env extends OrdoEnv = OrdoEnv> =
  readonly (readonly RegisteredStep<Env>[])[];
export interface Intent {
  protocol: "cfordo/3";
  iterationId: number;
  dispatchToken: string;
}

/** HTTP responses. Execution history is present only on the detail endpoint. */
export interface ErrorInfo {
  code: string;
  message: string;
}
export interface ExecutionDetail {
  attemptId: number;
  iteration?: number;
  delivery?: number;
  action: Action;
  sourceRunId: number | null;
  status: AttemptStatus;
  output: JsonValue;
  verdict: CheckResult | null;
  error: ErrorInfo | null;
  createdAt: number;
  finishedAt: number | null;
}
export interface StepResult {
  stepName: string;
  status: EffectiveGoalStatus;
  action: Action | null;
  output: JsonValue;
  validation: CheckResult | null;
  evaluation: CheckResult | null;
  error: ErrorInfo | null;
  createdAt: number | null;
  finishedAt: number | null;
}
export interface GoalSummary {
  goalId: number;
  input: JsonValue;
  status: EffectiveGoalStatus;
  createdAt: number;
  expiresAt: number;
  finishedAt: number | null;
  error: ErrorInfo | null;
  results: StepResult[];
}
export interface GoalDetail extends GoalSummary {
  results: (StepResult & { executions: ExecutionDetail[] })[];
}
export interface GoalCreated {
  goalId: number;
}
export interface ApiErrorResponse {
  error: ErrorInfo;
  goalId?: number;
}
