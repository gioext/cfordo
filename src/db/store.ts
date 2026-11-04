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
} from "../types.ts";

interface GoalRow {
  id: number;
  input_json: string;
  status: GoalStatus;
  error_json: string | null;
  workflow_name: string | null;
  instance_id: string | null;
  created_at: number;
  expires_at: number;
  finished_at: number | null;
}
interface AttemptRow {
  id: number;
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
    workflowName: row.workflow_name,
    instanceId: row.instance_id,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    finishedAt: row.finished_at,
  };
}
function attempt(row: AttemptRow): Attempt {
  return {
    id: row.id,
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

// Both the HTTP response and the Workflow event may arrive first.
export async function attachWorkflow(
  db: DatabaseBinding,
  id: number,
  instanceId: string,
  workflowName: string | null = null,
): Promise<void> {
  const result = await db
    .prepare(
      `UPDATE cfordo_goals
    SET instance_id = ?, workflow_name = COALESCE(workflow_name, ?)
    WHERE id = ? AND (instance_id IS NULL OR instance_id = ?)
    AND (? IS NULL OR workflow_name IS NULL OR workflow_name = ?)`,
    )
    .bind(instanceId, workflowName, id, instanceId, workflowName, workflowName)
    .run();
  if (!result.success)
    throw new Error(result.error || "Workflow association failed");
  if (result.meta.changes !== 1) {
    await getGoal(db, id);
    throw new Error(`Goal ${id} belongs to a different Workflow instance`);
  }
}

export async function listGoals(db: DatabaseBinding): Promise<Goal[]> {
  const result = await db
    .prepare("SELECT * FROM cfordo_goals ORDER BY id DESC")
    .all<GoalRow>();
  if (!result.success) throw new Error(result.error || "Goal query failed");
  return (result.results ?? []).map(goal);
}

export async function listAllAttempts(db: DatabaseBinding): Promise<Attempt[]> {
  const result = await db
    .prepare(
      "SELECT * FROM cfordo_attempts WHERE action IS NOT NULL ORDER BY id",
    )
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

export async function ensureAttempt(
  db: DatabaseBinding,
  goalId: number,
  stepName: string,
  action: Action,
  predecessorId: number | null,
  sourceRunId: number | null,
  now = Date.now(),
): Promise<void> {
  // worker_name is retained for compatibility with existing databases.
  const result = await db
    .prepare(
      `INSERT INTO cfordo_attempts
    (goal_id, step_name, worker_name, action, predecessor_id, source_run_id, created_at)
    SELECT id, ?, ?, ?, ?, ?, ? FROM cfordo_goals
    WHERE id = ? AND status = 'running' AND expires_at > ?
    ON CONFLICT DO NOTHING`,
    )
    .bind(
      stepName,
      stepName,
      action,
      predecessorId,
      sourceRunId,
      now,
      goalId,
      now,
    )
    .run();
  if (!result.success)
    throw new Error(result.error || "Action creation failed");
}
export async function getAttempt(
  db: DatabaseBinding,
  id: number,
): Promise<Attempt> {
  const row = await db
    .prepare("SELECT * FROM cfordo_attempts WHERE id = ?")
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
            "SELECT * FROM cfordo_attempts WHERE goal_id = ? AND action IS NOT NULL ORDER BY id",
          )
          .bind(goalId)
      : db
          .prepare(
            "SELECT * FROM cfordo_attempts WHERE goal_id = ? AND step_name = ? AND action IS NOT NULL ORDER BY id",
          )
          .bind(goalId, stepName);
  const result = await statement.all<AttemptRow>();
  if (!result.success) throw new Error(result.error || "Action query failed");
  return (result.results ?? []).map(attempt);
}
export async function claimAttempt(
  db: DatabaseBinding,
  id: number,
  now = Date.now(),
): Promise<boolean> {
  const result = await db
    .prepare(
      `UPDATE cfordo_attempts SET status = 'running'
    WHERE id = ? AND status = 'ready' AND action IS NOT NULL
    AND EXISTS (SELECT 1 FROM cfordo_goals g WHERE g.id = goal_id AND g.status = 'running' AND g.expires_at > ?)`,
    )
    .bind(id, now)
    .run();
  if (!result.success) throw new Error(result.error || "Action claim failed");
  return (result.meta.changes ?? 0) === 1;
}

const outcomeColumns = {
  run: "output_json",
  validate: "validation_json",
  evaluate: "evaluation_json",
} as const;
export async function saveOutcome(
  db: DatabaseBinding,
  id: number,
  action: Action,
  value: JsonValue | CheckResult,
): Promise<void> {
  const result = await db
    .prepare(
      `UPDATE cfordo_attempts SET ${outcomeColumns[action]} = ?
    WHERE id = ? AND action = ? AND status = 'running'`,
    )
    .bind(JSON.stringify(value), id, action)
    .run();
  if (!result.success || result.meta.changes !== 1)
    throw new Error(
      result.error || "Cannot save to an execution that is not running",
    );
}
export async function finishAttempt(
  db: DatabaseBinding,
  id: number,
  now = Date.now(),
): Promise<void> {
  const result = await db
    .prepare(
      `UPDATE cfordo_attempts SET status = 'completed', finished_at = ?
    WHERE id = ? AND status = 'running' AND (
      (action = 'run' AND output_json IS NOT NULL) OR
      (action = 'validate' AND validation_json IS NOT NULL) OR
      (action = 'evaluate' AND evaluation_json IS NOT NULL))`,
    )
    .bind(now, id)
    .run();
  if (!result.success || result.meta.changes !== 1)
    throw new Error(
      result.error || "Action ended without a saved result or verdict",
    );
}
export async function failAttempt(
  db: DatabaseBinding,
  id: number,
  error: AttemptError,
  expected: "ready" | "running" = "running",
  now = Date.now(),
): Promise<void> {
  const result = await db
    .prepare(
      `UPDATE cfordo_attempts SET status = 'failed', error_json = ?, finished_at = ?
    WHERE id = ? AND status = ?`,
    )
    .bind(JSON.stringify(error), now, id, expected)
    .run();
  if (!result.success)
    throw new Error(result.error || "Action failure could not be saved");
}
