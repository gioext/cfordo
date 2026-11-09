import type {
  Action,
  Attempt,
  AttemptError,
  AttemptStatus,
  CheckResult,
  DatabaseBinding,
  Goal,
  GoalStatus,
  JsonValue,
  Iteration,
  IterationResult,
} from "../types.ts";

interface GoalRow {
  id: number;
  input_json: string;
  status: GoalStatus;
  error_json: string | null;
  created_at: number;
  expires_at: number;
  finished_at: number | null;
}
interface AttemptRow {
  id: number;
  iteration_id: number | null;
  iteration: number | null;
  delivery: number | null;
  dispatch_token: string | null;
  goal_id: number;
  step_name: string;
  action: Action | null;
  predecessor_id: number | null;
  source_run_id: number | null;
  status: AttemptStatus;
  output_json: string | null;
  validation_json: string | null;
  evaluation_json: string | null;
  error_json: string | null;
  created_at: number;
  finished_at: number | null;
}
function goal(row: GoalRow): Goal {
  return {
    id: row.id,
    input: JSON.parse(row.input_json),
    status: row.status,
    error: row.error_json === null ? null : JSON.parse(row.error_json),
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    finishedAt: row.finished_at,
  };
}
function attempt(row: AttemptRow): Attempt {
  return {
    id: row.id,
    iterationId: row.iteration_id,
    iteration: row.iteration,
    delivery: row.delivery,
    dispatchToken: row.dispatch_token,
    goalId: row.goal_id,
    stepName: row.step_name,
    action: row.action,
    predecessorId: row.predecessor_id,
    sourceRunId: row.source_run_id,
    status: row.status,
    output: row.output_json === null ? undefined : JSON.parse(row.output_json),
    validation:
      row.validation_json === null ? null : JSON.parse(row.validation_json),
    evaluation:
      row.evaluation_json === null ? null : JSON.parse(row.evaluation_json),
    error: row.error_json === null ? null : JSON.parse(row.error_json),
    createdAt: row.created_at,
    finishedAt: row.finished_at,
  };
}

export class GoalNotFoundError extends Error {
  constructor(id: number) {
    super(`Goal ${id} not found`);
  }
}

export async function insertGoal(
  db: DatabaseBinding,
  input: JsonValue,
  expiresIn: number,
  now = Date.now(),
): Promise<Goal> {
  const row = await db
    .prepare(
      `INSERT INTO cfordo_goals
    (input_json, created_at, expires_at) VALUES (?, ?, ?) RETURNING *`,
    )
    .bind(JSON.stringify(input), now, now + expiresIn)
    .first<GoalRow>();
  if (!row) throw new Error("Goal creation failed");
  return goal(row);
}

export async function listPendingGoals(
  db: DatabaseBinding,
  now = Date.now(),
): Promise<Goal[]> {
  const result = await db
    .prepare(
      "SELECT * FROM cfordo_goals WHERE status IN ('ready', 'running') AND expires_at > ? ORDER BY id",
    )
    .bind(now)
    .all<GoalRow>();
  if (!result.success)
    throw new Error(result.error || "Pending Goal query failed");
  return (result.results ?? []).map(goal);
}

export async function listGoals(db: DatabaseBinding): Promise<Goal[]> {
  const result = await db
    .prepare("SELECT * FROM cfordo_goals ORDER BY id DESC")
    .all<GoalRow>();
  if (!result.success) throw new Error(result.error || "Goal query failed");
  return (result.results ?? []).map(goal);
}

const attemptQuery = `SELECT a.*, i.iteration FROM cfordo_attempts a
  LEFT JOIN cfordo_iterations i ON i.id = a.iteration_id`;

export async function listAllAttempts(db: DatabaseBinding): Promise<Attempt[]> {
  const result = await db
    .prepare(`${attemptQuery} WHERE a.action IS NOT NULL ORDER BY a.id`)
    .all<AttemptRow>();
  if (!result.success)
    throw new Error(result.error || "Execution query failed");
  return (result.results ?? []).map(attempt);
}

export async function getGoal(db: DatabaseBinding, id: number): Promise<Goal> {
  const row = await db
    .prepare("SELECT * FROM cfordo_goals WHERE id = ?")
    .bind(id)
    .first<GoalRow>();
  if (!row) throw new GoalNotFoundError(id);
  return goal(row);
}
export async function updateGoal(
  db: DatabaseBinding,
  id: number,
  status: "running" | "completed" | "failed",
  error?: AttemptError,
  now = Date.now(),
): Promise<void> {
  const result = await db
    .prepare(
      `UPDATE cfordo_goals SET status = ?, finished_at = ?, error_json = ?
    WHERE id = ? AND status IN ('ready', 'running') AND expires_at > ?`,
    )
    .bind(
      status,
      status === "running" ? null : now,
      error ? JSON.stringify(error) : null,
      id,
      now,
    )
    .run();
  if (!result.success) throw new Error(result.error || "Goal update failed");
}

export async function getAttempt(
  db: DatabaseBinding,
  id: number,
): Promise<Attempt> {
  const row = await db
    .prepare(`${attemptQuery} WHERE a.id = ?`)
    .bind(id)
    .first<AttemptRow>();
  if (!row) throw new Error(`Action execution ${id} not found`);
  return attempt(row);
}
export async function listAttempts(
  db: DatabaseBinding,
  goalId: number,
  stepName?: string,
): Promise<Attempt[]> {
  const statement =
    stepName === undefined
      ? db
          .prepare(
            `${attemptQuery} WHERE a.goal_id = ? AND a.action IS NOT NULL ORDER BY a.id`,
          )
          .bind(goalId)
      : db
          .prepare(
            `${attemptQuery} WHERE a.goal_id = ? AND a.step_name = ? AND a.action IS NOT NULL ORDER BY a.id`,
          )
          .bind(goalId, stepName);
  const result = await statement.all<AttemptRow>();
  if (!result.success) throw new Error(result.error || "Action query failed");
  return (result.results ?? []).map(attempt);
}
interface IterationRow {
  id: number;
  goal_id: number;
  step_name: string;
  iteration: number;
  dispatch_status: Iteration["dispatchStatus"];
  created_at: number;
}
function iteration(row: IterationRow): Iteration {
  return {
    id: row.id,
    goalId: row.goal_id,
    stepName: row.step_name,
    iteration: row.iteration,
    dispatchStatus: row.dispatch_status,
    createdAt: row.created_at,
  };
}
export class ExecutionStopped extends Error {}

export async function listIterationResults(
  db: DatabaseBinding,
  goalId?: number,
): Promise<IterationResult[]> {
  // Final records share the history table. Legacy action-less rows have no iteration.
  const query = `SELECT id, iteration_id, predecessor_id AS attempt_id, error_json, finished_at
    FROM cfordo_attempts WHERE iteration_id IS NOT NULL AND action IS NULL`;
  const result = await db
    .prepare(
      query + (goalId === undefined ? "" : " AND goal_id = ?") + " ORDER BY id",
    )
    .bind(...(goalId === undefined ? [] : [goalId]))
    .all<{
      id: number;
      iteration_id: number;
      attempt_id: number | null;
      error_json: string | null;
      finished_at: number;
    }>();
  if (!result.success)
    throw new Error(result.error || "Iteration result query failed");
  return (result.results ?? []).map((row) => ({
    id: row.id,
    iterationId: row.iteration_id,
    attemptId: row.attempt_id,
    error: row.error_json === null ? null : JSON.parse(row.error_json),
    finishedAt: row.finished_at,
  }));
}

export async function listIterations(
  db: DatabaseBinding,
  goalId?: number,
  stepName?: string,
): Promise<Iteration[]> {
  let query = "SELECT * FROM cfordo_iterations";
  const bindings: (number | string)[] = [];
  if (goalId !== undefined) {
    query += " WHERE goal_id = ?";
    bindings.push(goalId);
  }
  if (stepName !== undefined) {
    query += " AND step_name = ?";
    bindings.push(stepName);
  }
  const result = await db
    .prepare(query + " ORDER BY id")
    .bind(...bindings)
    .all<IterationRow>();
  if (!result.success)
    throw new Error(result.error || "Iteration query failed");
  return (result.results ?? []).map(iteration);
}
export async function getIteration(
  db: DatabaseBinding,
  id: number,
): Promise<Iteration> {
  const row = await db
    .prepare("SELECT * FROM cfordo_iterations WHERE id = ?")
    .bind(id)
    .first<IterationRow>();
  if (!row) throw new Error(`Iteration ${id} not found`);
  return iteration(row);
}
export async function ensureIteration(
  db: DatabaseBinding,
  goalId: number,
  stepName: string,
  number: number,
): Promise<void> {
  const now = Date.now();
  const result = await db
    .prepare(
      `INSERT INTO cfordo_iterations (goal_id, step_name, iteration, created_at)
    SELECT id, ?, ?, ? FROM cfordo_goals WHERE id = ? AND status = 'running' AND expires_at > ?
    ON CONFLICT DO NOTHING`,
    )
    .bind(stepName, number, now, goalId, now)
    .run();
  if (!result.success)
    throw new Error(result.error || "Iteration creation failed");
}

// Only an interrupted/failed send is eligible for another dispatch. Queued and running work is never resent by Cron.
export async function reserveDispatch(
  db: DatabaseBinding,
  id: number,
  token: string,
): Promise<boolean> {
  const now = Date.now();
  const result = await db
    .prepare(
      `UPDATE cfordo_iterations SET dispatch_status='sending', dispatch_token=?, dispatch_until=?
    WHERE id=? AND (dispatch_status='ready' OR (dispatch_status='sending' AND dispatch_until <= ?))
    AND EXISTS (SELECT 1 FROM cfordo_goals g WHERE g.id=goal_id AND g.status='running' AND g.expires_at>?)`,
    )
    .bind(token, now + 60_000, id, now, now)
    .run();
  if (!result.success)
    throw new Error(result.error || "Dispatch reservation failed");
  return result.meta.changes === 1;
}
export async function finishDispatch(
  db: DatabaseBinding,
  id: number,
  token: string,
  sent: boolean,
): Promise<void> {
  const result = await db
    .prepare(
      `UPDATE cfordo_iterations SET dispatch_status=?, dispatch_until=NULL
    WHERE id=? AND dispatch_status='sending' AND dispatch_token=?`,
    )
    .bind(sent ? "queued" : "ready", id, token)
    .run();
  if (!result.success)
    throw new Error(result.error || "Dispatch update failed");
}
export async function beginAttempt(
  db: DatabaseBinding,
  round: Iteration,
  dispatchToken: string,
  delivery: number,
  action: Action,
  sourceRunId: number | null,
  predecessorId: number | null,
): Promise<Attempt> {
  const now = Date.now();
  const row = await db
    .prepare(
      `INSERT INTO cfordo_attempts
    (goal_id,step_name,worker_name,action,predecessor_id,source_run_id,status,created_at,iteration_id,delivery,dispatch_token)
    SELECT goal_id,step_name,step_name,?,?,?,'running',?,id,?,? FROM cfordo_iterations
    WHERE id=? AND EXISTS (SELECT 1 FROM cfordo_goals g WHERE g.id=goal_id AND g.expires_at>?) RETURNING id`,
    )
    .bind(
      action,
      predecessorId,
      sourceRunId,
      now,
      delivery,
      dispatchToken,
      round.id,
      now,
    )
    .first<{ id: number }>();
  if (!row) throw new ExecutionStopped("Goal has expired");
  return getAttempt(db, row.id);
}
const outcomeColumns = {
  run: "output_json",
  validate: "validation_json",
  evaluate: "evaluation_json",
} as const;
export async function saveOutcome(
  db: DatabaseBinding,
  attempt: Attempt,
  value: JsonValue | CheckResult,
): Promise<void> {
  if (!attempt.action) throw new Error("Action missing");
  const result = await db
    .prepare(
      `UPDATE cfordo_attempts SET ${outcomeColumns[attempt.action]}=?
    WHERE id=? AND status='running'`,
    )
    .bind(JSON.stringify(value), attempt.id)
    .run();
  if (!result.success) throw new Error(result.error || "Outcome save failed");
  if (result.meta.changes !== 1) throw new Error("Action is no longer running");
}
export async function finishAttempt(
  db: DatabaseBinding,
  attempt: Attempt,
): Promise<void> {
  const result = await db
    .prepare(
      `UPDATE cfordo_attempts SET status='completed', finished_at=?
    WHERE id=? AND status='running' AND ${outcomeColumns[attempt.action!]} IS NOT NULL`,
    )
    .bind(Date.now(), attempt.id)
    .run();
  if (!result.success)
    throw new Error(result.error || "Action completion failed");
  if (result.meta.changes !== 1)
    throw new Error("Action has no saved outcome or has already ended");
}

export async function saveIterationResult(
  db: DatabaseBinding,
  iterationId: number,
  attemptId: number | null,
  error?: AttemptError,
): Promise<void> {
  // Append after the execution ends: this ID records final persistence order.
  // action=NULL keeps the record out of the public run/validate/evaluate history.
  const now = Date.now();
  const result = await db
    .prepare(
      `INSERT INTO cfordo_attempts
      (goal_id,step_name,worker_name,iteration_id,predecessor_id,status,error_json,created_at,finished_at)
      SELECT goal_id,step_name,step_name,id,?,?,?,?,? FROM cfordo_iterations WHERE id=?`,
    )
    .bind(
      attemptId,
      error ? "failed" : "completed",
      error ? JSON.stringify(error) : null,
      now,
      now,
      iterationId,
    )
    .run();
  if (!result.success)
    throw new Error(result.error || "Iteration result save failed");
  if (result.meta.changes !== 1)
    throw new Error("Iteration missing while saving its result");
}

export async function failAttempt(
  db: DatabaseBinding,
  attempt: Attempt,
  error: AttemptError,
): Promise<void> {
  const result = await db
    .prepare(
      `UPDATE cfordo_attempts SET status='failed',error_json=?,finished_at=?
      WHERE id=? AND status='running'`,
    )
    .bind(JSON.stringify(error), Date.now(), attempt.id)
    .run();
  if (!result.success)
    throw new Error(result.error || "Action failure save failed");
}

export async function exhaustIteration(
  db: DatabaseBinding,
  round: Iteration,
  dispatchToken: string,
): Promise<void> {
  const history = await listAttempts(db, round.goalId, round.stepName);
  const last = history
    .filter(
      (a) => a.iterationId === round.id && a.dispatchToken === dispatchToken,
    )
    .at(-1);
  await saveIterationResult(db, round.id, last?.id ?? null, {
    source: "queue",
    name: "QueueRetriesExhausted",
    message: last?.error
      ? `Queue retries exhausted: ${last.error.message}`
      : "Queue retries exhausted before the iteration completed",
  });
}
