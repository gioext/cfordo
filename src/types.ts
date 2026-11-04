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
> {
  input(): { params: Params; result: Phase extends "run" ? undefined : Result };
  complete: Phase extends "run" ? (value: Result) => Promise<void> : never;
  ok: Phase extends "run" ? never : () => Promise<void>;
  ng: Phase extends "run" ? never : (reason: string) => Promise<void>;
  readonly goalId: number;
  readonly stepName: string;
  readonly attemptId: number;
  readonly feedback?: { source: CheckSource; reason: string };
}

export type CheckFunction<Params = any, Result = any> = (
  ctx: OrdoContext<Params, Result, CheckSource>,
) => Promise<void>;

export interface StepDefinition<Params = any, Result = any> {
  name: string;
  run(ctx: OrdoContext<Params, Result, "run">): Promise<void>;
  validate?: CheckFunction<Params, Result>;
  evaluate?: CheckFunction<Params, Result>;
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

export interface QueueBinding {
  send(message: unknown): Promise<unknown>;
}

export interface WorkflowStepBinding {
  do(
    name: string,
    config: { retries: { limit: number; delay: number } },
    callback: () => Promise<void>,
  ): Promise<void>;
  waitForEvent(
    name: string,
    options: { type: string },
  ): Promise<{ payload: unknown }>;
}

export interface GoalParams {
  goalId: number;
}

export interface OrdoEnv {
  DB: D1Database;
  QUEUE: Queue;
  WORKFLOW: Workflow<GoalParams>;
}

export interface CoreEnv {
  DB: DatabaseBinding;
  QUEUE: QueueBinding;
  WORKFLOW: WorkflowBinding;
}

export interface WorkflowBinding {
  create(options: { params: GoalParams }): Promise<{ id: string }>;
  get(id: string): Promise<{
    sendEvent(event: { type: string; payload: unknown }): Promise<void>;
    status(): Promise<{
      status: InstanceStatus["status"];
      error?: { message: string; name: string };
    }>;
  }>;
}

export interface QueueMessage {
  readonly id: string;
  readonly body: unknown;
  readonly attempts: number;
  readonly timestamp: Date;
  ack(): void;
  retry(options?: { delaySeconds?: number }): void;
}

export interface QueueBatch {
  readonly queue: string;
  readonly messages: readonly QueueMessage[];
  ackAll(): void;
  retryAll(options?: { delaySeconds?: number }): void;
}

export interface QueueContext {
  waitUntil(promise: Promise<unknown>): void;
}

export type QueueHandler<Env = unknown> = (
  batch: QueueBatch,
  env: Env,
  ctx: QueueContext,
) => Promise<void>;

export interface OrdoBindings {
  db: DatabaseBinding;
  queue: QueueBinding;
  workflow: WorkflowBinding;
}

export interface OrdoOptions {
  /** Goal lifetime in milliseconds; defaults to 24 hours. */
  expiresIn?: number;
}

export interface OrdoRegistration<Params = any> {
  configure(options: OrdoOptions): void;
  step<Result = any>(definition: StepDefinition<Params, Result>): void;
  parallel(callback: () => Promise<void>): Promise<void>;
}

// Internal records and protocol. They are not re-exported by the package entrypoint.
/** Persisted check records, never accepted directly from user callbacks. */
export type CheckResult = { ok: true } | { ok: false; reason: string };

export interface Goal {
  id: number;
  input: JsonValue;
  error: AttemptError | null;
  workflowName: string | null;
  instanceId: string | null;
  status: GoalStatus;
  createdAt: number;
  expiresAt: number;
  finishedAt: number | null;
}

export type ErrorSource = "run" | CheckSource | "dispatch" | "configuration";
export interface AttemptError {
  source: ErrorSource;
  name: string;
  message: string;
  fatal?: boolean;
  stack?: string;
}

export interface Attempt {
  id: number;
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

export type RegisteredStep = StepDefinition;

export type Playbook = readonly (readonly RegisteredStep[])[];
export interface Intent {
  protocol: "cfordo/2";
  attemptId: number;
}

export interface WorkflowIdentity {
  workflowName: string;
  instanceId: string;
}

export interface Runtime {
  db: DatabaseBinding;
  queue: QueueBinding;
  step: WorkflowStepBinding;
  event: WorkflowIdentity;
}

export type WorkerExecutor = (
  intent: Intent,
  bindings: OrdoBindings,
) => Promise<void>;

// Application failures are recorded and counted by cfordo, not multiplied by
// WorkflowStep's default retry policy. No delay is used with a zero retry limit.
export const NO_WORKFLOW_RETRIES = { retries: { limit: 0, delay: 0 } } as const;

export function completionType(attemptId: number): string {
  return `ordo-completed-${attemptId}`;
}

/** HTTP responses. Execution history is present only on the detail endpoint. */
export interface ErrorInfo {
  code: string;
  message: string;
}
export interface ExecutionDetail {
  attemptId: number;
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
