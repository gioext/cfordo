import type {
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
  created_at: number;
  expires_at: number;
  finished_at: number | null;
}
interface AttemptRow {
  id: number;
  goal_id: number;
  step_name: string;
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

export async function insertGoal(
  db: DatabaseBinding,
  input: JsonValue,
  expiresIn: number,
  now = Date.now(),
): Promise<Goal> {
  const row = await db
    .prepare(
      "INSERT INTO cfordo_goals (input_json, created_at, expires_at) VALUES (?, ?, ?) RETURNING *",
    )
    .bind(JSON.stringify(input), now, now + expiresIn)
    .first<GoalRow>();
  if (!row) throw new Error("Goal creation returned no record");
  return goal(row);
}

export async function getGoal(db: DatabaseBinding, id: number): Promise<Goal> {
  const row = await db
    .prepare("SELECT * FROM cfordo_goals WHERE id = ?")
    .bind(id)
    .first<GoalRow>();
  if (!row) throw new Error(`Goal ${id} not found`);
  return goal(row);
}

export async function updateGoal(
  db: DatabaseBinding,
  id: number,
  status: "running" | "completed" | "failed",
  now = Date.now(),
): Promise<void> {
  const result = await db
    .prepare(
      `UPDATE cfordo_goals SET status = ?, finished_at = ?
    WHERE id = ? AND status IN ('ready', 'running') AND expires_at > ?`,
    )
    .bind(status, status === "running" ? null : now, id, now)
    .run();
  if (!result.success) throw new Error(result.error || "Goal update failed");
}

export async function insertAttempt(
  db: DatabaseBinding,
  goalId: number,
  stepName: string,
  now = Date.now(),
): Promise<Attempt | null> {
  const row = await db
    .prepare(
      `INSERT INTO cfordo_attempts (goal_id, step_name, worker_name, created_at)
    SELECT id, ?, ?, ? FROM cfordo_goals WHERE id = ? AND status = 'running' AND expires_at > ? RETURNING *`,
    )
    .bind(stepName, stepName, now, goalId, now)
    .first<AttemptRow>();
  return row ? attempt(row) : null;
}

export async function getAttempt(
  db: DatabaseBinding,
  id: number,
): Promise<Attempt> {
  const row = await db
    .prepare("SELECT * FROM cfordo_attempts WHERE id = ?")
    .bind(id)
    .first<AttemptRow>();
  if (!row) throw new Error(`Attempt ${id} not found`);
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
            "SELECT * FROM cfordo_attempts WHERE goal_id = ? ORDER BY id",
          )
          .bind(goalId)
      : db
          .prepare(
            "SELECT * FROM cfordo_attempts WHERE goal_id = ? AND step_name = ? ORDER BY id",
          )
          .bind(goalId, stepName);
  const result = await statement.all<AttemptRow>();
  if (!result.success) throw new Error(result.error || "Attempt query failed");
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
    WHERE id = ? AND status = 'ready'
      AND EXISTS (SELECT 1 FROM cfordo_goals g WHERE g.id = goal_id AND g.status = 'running' AND g.expires_at > ?)`,
    )
    .bind(id, now)
    .run();
  if (!result.success) throw new Error(result.error || "Attempt claim failed");
  return (result.meta.changes ?? 0) === 1;
}

export interface AttemptPatch {
  status?: AttemptStatus;
  output?: JsonValue;
  validation?: CheckResult | null;
  evaluation?: CheckResult | null;
  error?: AttemptError | null;
  finishedAt?: number;
}

export async function updateAttempt(
  db: DatabaseBinding,
  id: number,
  patch: AttemptPatch,
): Promise<boolean> {
  const fields: string[] = [];
  const values: unknown[] = [];
  const columns = {
    output: "output_json",
    validation: "validation_json",
    evaluation: "evaluation_json",
    error: "error_json",
  } as const;
  for (const key of Object.keys(columns) as (keyof typeof columns)[]) {
    if (Object.hasOwn(patch, key) && patch[key] !== undefined) {
      fields.push(`${columns[key]} = ?`);
      values.push(
        key !== "output" && patch[key] === null
          ? null
          : JSON.stringify(patch[key]),
      );
    }
  }
  if (patch.status !== undefined) {
    fields.push("status = ?");
    values.push(patch.status);
  }
  if (patch.finishedAt !== undefined) {
    fields.push("finished_at = ?");
    values.push(patch.finishedAt);
  }
  if (!fields.length) return false;
  const result = await db
    .prepare(
      `UPDATE cfordo_attempts SET ${fields.join(", ")}
    WHERE id = ? AND status NOT IN ('completed', 'failed')`,
    )
    .bind(...values, id)
    .run();
  if (!result.success) throw new Error(result.error || "Attempt update failed");
  return (result.meta.changes ?? 0) === 1;
}
