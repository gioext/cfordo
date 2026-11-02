export type JsonValue =
  null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
export type GoalStatus = "ready" | "running" | "completed" | "failed";
export type RunStatus = "completed" | "failed" | "expired";
export type EffectiveGoalStatus = GoalStatus | "expired";
export type AttemptStatus =
  "ready" | "running" | "validating" | "evaluating" | "completed" | "failed";
export type CheckSource = "validate" | "evaluate";

export interface OrdoContext {
  /** Optional type arguments describe the value; they do not validate it. */
  params<T = any>(): T;
  /** Undefined during run(), otherwise the business result being checked. */
  result<T = any>(): T;
  ok(): CheckDecision;
  ng(reason: string): CheckDecision;
  goalId: number;
  stepName: string;
  attemptId: number;
  feedback?: { source: CheckSource; reason: string };
}

declare const decisionBrand: unique symbol;
/** Only context.ok()/ng() can create a check decision. */
export interface CheckDecision {
  readonly [decisionBrand]: true;
}
export type CheckFunction = (ctx: OrdoContext) => Promise<CheckDecision>;

export interface StepDefinition {
  name: string;
  run(ctx: OrdoContext): Promise<unknown>;
  validate?: CheckFunction;
  evaluate?: CheckFunction;
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
  do<Value extends JsonValue>(
    name: string,
    config: { retries: { limit: number; delay: number } },
    callback: () => Promise<Value>,
  ): Promise<Value>;
  waitForEvent(
    name: string,
    options: { type: string },
  ): Promise<{ payload: unknown }>;
}

export interface WorkflowBinding {
  get(id: string): Promise<{
    sendEvent(event: { type: string; payload: unknown }): Promise<void>;
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

export interface OrdoRegistration {
  binding(bindings: OrdoBindings): void;
  configure(options: OrdoOptions): void;
  step(definition: StepDefinition): void;
  parallel(callback: () => Promise<void>): Promise<void>;
}

// Internal records and protocol. They are not re-exported by the package entrypoint.
/** Persisted check records, never accepted directly from user callbacks. */
export type CheckResult = { ok: true } | { ok: false; reason: string };

export interface Goal {
  id: number;
  input: JsonValue;
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
}

export interface Attempt {
  id: number;
  goalId: number;
  stepName: string;
  status: AttemptStatus;
  output: JsonValue | undefined;
  validation: CheckResult | null;
  evaluation: CheckResult | null;
  error: AttemptError | null;
  createdAt: number;
  finishedAt: number | null;
}

export type RegisteredStep = StepDefinition;
export type WorkerDefinition = Pick<StepDefinition, "run" | "validate">;

export type Playbook = readonly (readonly RegisteredStep[])[];
export type ResumePhase = "validate" | "evaluate";
export interface Intent {
  protocol: "cfordo/1";
  goalId: number;
  stepName: string;
  attemptId: number;
  instanceId: string;
  feedback?: OrdoContext["feedback"];
  resume?: { phase: ResumePhase; attemptId: number };
}

export interface Runtime {
  db: DatabaseBinding;
  queue: QueueBinding;
  step: WorkflowStepBinding;
  event: { instanceId: string };
}

export type AttemptOutcome = "completed" | "retry" | "failed" | "expired";
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
