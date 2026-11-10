import type {
  Action,
  Attempt,
  AttemptError,
  AttemptStatus,
  CheckResult,
  DatabaseBinding,
  DatabaseResult,
  Goal,
  GoalStatus,
  JsonValue,
} from "../types.ts";
import { DatabaseError, query } from "./query.ts";
import { tables } from "./schema.ts";

interface GoalRow {
  id: number;
  input_json: string;
  status: GoalStatus;
  created_at: number;
  finished_at: number | null;
}
interface AttemptRow {
  id: number;
  goal_id: number;
  step_name: string;
  action: Action | null;
  predecessor_id: number | null;
  delivery_id: number;
  run_id: number | null;
  run_created_at: number | null;
  status: AttemptStatus | null;
  output_json: string | null;
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
    deliveryId: row.delivery_id,
    runId: row.run_id,
    runCreatedAt: row.run_created_at,
    status: row.status,
    output: row.output_json === null ? undefined : JSON.parse(row.output_json),
    error: row.error_json === null ? null : JSON.parse(row.error_json),
    createdAt: row.created_at,
    finishedAt: row.finished_at,
  };
}
function checked<Row>(result: DatabaseResult<Row>): DatabaseResult<Row> {
  if (!result.success)
    throw new DatabaseError(result.error || "Database operation failed");
  return result;
}
export class GoalNotFoundError extends Error {
  constructor(id: number) {
    super(`Goal ${id} not found`);
  }
}
export class ExecutionStopped extends Error {}

// Ownership, delivery and run identity have one stored source: the root and its links.
const tree = `WITH RECURSIVE history AS (
  SELECT id, goal_id, step_name, action, predecessor_id, status, output_json,
    error_json, created_at, finished_at, id AS delivery_id,
    NULL AS run_id, NULL AS run_created_at
  FROM ${tables.attempts} WHERE predecessor_id IS NULL
  UNION ALL
  SELECT a.id, h.goal_id, h.step_name, a.action, a.predecessor_id, a.status,
    a.output_json, a.error_json, a.created_at, a.finished_at,
    CASE WHEN a.action IS NULL THEN a.id ELSE h.delivery_id END,
    CASE WHEN a.action IS NULL THEN NULL WHEN a.action='run' THEN a.id ELSE h.run_id END,
    CASE WHEN a.action IS NULL THEN NULL WHEN a.action='run' THEN a.created_at ELSE h.run_created_at END
  FROM ${tables.attempts} a JOIN history h ON a.predecessor_id=h.id
)`;
export const DELIVERY_TIMEOUT = 60_000;
export const EXECUTION_TIMEOUT = 15 * 60_000;
const currentDelivery = `NOT EXISTS (SELECT 1 FROM ${tables.attempts} d
  WHERE d.predecessor_id=h.delivery_id AND d.action IS NULL)`;
const activeExecution = `EXISTS (SELECT 1 FROM history h JOIN ${tables.goals} g ON g.id=h.goal_id
  WHERE h.id=a.id AND g.status='running' AND g.created_at+?>?
  AND h.run_created_at+${EXECUTION_TIMEOUT}>? AND ${currentDelivery})`;

export async function insertGoal(
  db: DatabaseBinding,
  input: JsonValue,
): Promise<Goal> {
  const row = await query(
    db
      .prepare(
        `INSERT INTO ${tables.goals}
    (input_json,created_at) VALUES (?,?) RETURNING *`,
      )
      .bind(JSON.stringify(input), Date.now())
      .first<GoalRow>(),
  );
  if (!row) throw new Error("Goal creation failed");
  return goal(row);
}
export async function listPendingGoals(db: DatabaseBinding): Promise<Goal[]> {
  const result = checked(
    await query(
      db
        .prepare(
          `SELECT * FROM ${tables.goals}
    WHERE status IN ('ready','running') ORDER BY id`,
        )
        .all<GoalRow>(),
    ),
  );
  return (result.results ?? []).map(goal);
}
export async function listGoals(db: DatabaseBinding): Promise<Goal[]> {
  return (
    checked(
      await query(
        db
          .prepare(`SELECT * FROM ${tables.goals} ORDER BY id DESC`)
          .all<GoalRow>(),
      ),
    ).results ?? []
  ).map(goal);
}
export async function getGoal(db: DatabaseBinding, id: number): Promise<Goal> {
  const row = await query(
    db
      .prepare(`SELECT * FROM ${tables.goals} WHERE id=?`)
      .bind(id)
      .first<GoalRow>(),
  );
  if (!row) throw new GoalNotFoundError(id);
  return goal(row);
}
export async function updateGoal(
  db: DatabaseBinding,
  id: number,
  status: Exclude<GoalStatus, "ready">,
  expiresIn: number,
  now = Date.now(),
): Promise<void> {
  checked(
    await query(
      db
        .prepare(
          `UPDATE ${tables.goals} SET status=?,finished_at=?
    WHERE id=? AND status IN ('ready','running') AND created_at+? ${status === "expired" ? "<=" : ">"} ?`,
        )
        .bind(status, status === "running" ? null : now, id, expiresIn, now)
        .run(),
    ),
  );
}
export async function listAttempts(
  db: DatabaseBinding,
  goalId?: number,
): Promise<Attempt[]> {
  const result = checked(
    await query(
      db
        .prepare(
          `${tree} SELECT * FROM history
    ${goalId === undefined ? "" : "WHERE goal_id=?"} ORDER BY id`,
        )
        .bind(...(goalId === undefined ? [] : [goalId]))
        .all<AttemptRow>(),
    ),
  );
  return (result.results ?? []).map(attempt);
}
export async function getAttempt(
  db: DatabaseBinding,
  id: number,
): Promise<Attempt> {
  const row = await query(
    db
      .prepare(`${tree} SELECT * FROM history WHERE id=?`)
      .bind(id)
      .first<AttemptRow>(),
  );
  if (!row) throw new Error(`Action execution ${id} not found`);
  return attempt(row);
}

// The planner chooses improvement or recovery. These predicates commit that decision
// only while the observed delivery/execution is still current.
export async function reserveDispatch(
  db: DatabaseBinding,
  goalId: number,
  stepName: string,
  delivery: Attempt | undefined,
  last: Attempt | undefined,
  recover: boolean,
  expiresIn: number,
): Promise<number | null> {
  const now = Date.now();
  if (!delivery) {
    const result = checked(
      await query(
        db
          .prepare(
            `INSERT INTO ${tables.attempts}
      (goal_id,step_name,created_at) SELECT id,?,? FROM ${tables.goals}
      WHERE id=? AND status='running' AND created_at+?>?
      ON CONFLICT DO NOTHING RETURNING id`,
          )
          .bind(stepName, now, goalId, expiresIn, now)
          .all<{ id: number }>(),
      ),
    );
    return result.results?.[0]?.id ?? null;
  }
  const statements = [];
  if (recover && last) {
    statements.push(
      db
        .prepare(
          `${tree} UPDATE ${tables.attempts} AS a SET status='expired',finished_at=?
      WHERE a.id=? AND a.status='running' AND EXISTS
      (SELECT 1 FROM history h JOIN ${tables.goals} g ON g.id=h.goal_id
       WHERE h.id=a.id AND g.status='running' AND g.created_at+?>?
       AND h.run_created_at+${EXECUTION_TIMEOUT}<=? AND ${currentDelivery})`,
        )
        .bind(now, last.id, expiresIn, now, now),
    );
  }
  const condition = last
    ? `EXISTS (SELECT 1 FROM history h WHERE h.id=? AND h.delivery_id=d.id
        AND h.status='${recover ? "expired" : "completed"}'
        ${recover ? `AND h.run_created_at+${EXECUTION_TIMEOUT}<=?` : "AND h.action IN ('validate','evaluate') AND json_extract(h.output_json,'$.ok')=0"}
        AND NOT EXISTS (SELECT 1 FROM ${tables.attempts} n WHERE n.predecessor_id=h.id AND n.action IS NOT NULL))`
    : `d.created_at+${DELIVERY_TIMEOUT}<=? AND NOT EXISTS
       (SELECT 1 FROM ${tables.attempts} r WHERE r.predecessor_id=d.id AND r.action='run')`;
  statements.push(
    db
      .prepare(
        `${tree} INSERT INTO ${tables.attempts} (predecessor_id,created_at)
    SELECT d.id,? FROM history d JOIN ${tables.goals} g ON g.id=d.goal_id
    WHERE d.id=? AND d.action IS NULL AND g.status='running' AND g.created_at+?>?
    AND ${condition} ON CONFLICT DO NOTHING RETURNING id`,
      )
      .bind(
        now,
        delivery.id,
        expiresIn,
        now,
        ...(last ? [last.id, ...(recover ? [now] : [])] : [now]),
      ),
  );
  const results = await query(db.batch<{ id: number }>(statements));
  results.forEach(checked);
  return results.at(-1)!.results?.[0]?.id ?? null;
}

export async function claimDelivery(
  db: DatabaseBinding,
  deliveryId: number,
  startedAt: number,
  expiresIn: number,
): Promise<Attempt | null> {
  const now = Date.now();
  const result = checked(
    await query(
      db
        .prepare(
          `${tree} INSERT INTO ${tables.attempts}
    (action,predecessor_id,status,created_at)
    SELECT 'run',h.id,'running',? FROM history h JOIN ${tables.goals} g ON g.id=h.goal_id
    WHERE h.id=? AND h.action IS NULL AND g.status='running' AND g.created_at+?>?
    AND h.created_at+${DELIVERY_TIMEOUT}>? AND ?+${EXECUTION_TIMEOUT}>? AND ${currentDelivery}
    ON CONFLICT DO NOTHING RETURNING id`,
        )
        .bind(startedAt, deliveryId, expiresIn, now, now, startedAt, now)
        .all<{ id: number }>(),
    ),
  );
  const row = result.results?.[0];
  return row ? getAttempt(db, row.id) : null;
}
export async function saveOutcome(
  db: DatabaseBinding,
  item: Attempt,
  value: JsonValue | CheckResult,
  expiresIn: number,
): Promise<void> {
  const now = Date.now();
  const result = checked(
    await query(
      db
        .prepare(
          `${tree} UPDATE ${tables.attempts} AS a SET output_json=?
    WHERE a.id=? AND a.status='running' AND ${activeExecution}`,
        )
        .bind(JSON.stringify(value), item.id, expiresIn, now, now)
        .run(),
    ),
  );
  if (result.meta.changes !== 1)
    throw new ExecutionStopped("Execution is no longer active");
}
// Completing a nonfinal phase and creating its successor are atomic, so a stopped
// execution always leaves either a final outcome or an unfinished phase to expire.
export async function finishAttempt(
  db: DatabaseBinding,
  item: Attempt,
  next: Action | null,
  expiresIn: number,
): Promise<Attempt | null> {
  const now = Date.now();
  const statements = [];
  if (next)
    statements.push(
      db
        .prepare(
          `${tree} INSERT INTO ${tables.attempts}
    (action,predecessor_id,status,created_at)
    SELECT ?,a.id,'running',? FROM ${tables.attempts} a WHERE a.id=? AND a.status='running'
    AND a.output_json IS NOT NULL AND ${activeExecution} RETURNING id`,
        )
        .bind(next, now, item.id, expiresIn, now, now),
    );
  statements.push(
    db
      .prepare(
        `${tree} UPDATE ${tables.attempts} AS a SET status='completed',finished_at=?
    WHERE a.id=? AND a.status='running' AND a.output_json IS NOT NULL AND ${activeExecution}`,
      )
      .bind(now, item.id, expiresIn, now, now),
  );
  const results = await query(db.batch<{ id: number }>(statements));
  results.forEach(checked);
  if (results.at(-1)!.meta.changes !== 1)
    throw new ExecutionStopped("Execution is no longer active");
  return next ? getAttempt(db, results[0].results![0].id) : null;
}
export async function failAttempt(
  db: DatabaseBinding,
  item: Attempt,
  error: AttemptError,
  expiresIn: number,
): Promise<void> {
  const now = Date.now();
  const result = checked(
    await query(
      db
        .prepare(
          `${tree} UPDATE ${tables.attempts} AS a
    SET status='failed',error_json=?,finished_at=? WHERE a.id=? AND a.status='running' AND ${activeExecution}`,
        )
        .bind(JSON.stringify(error), now, item.id, expiresIn, now, now)
        .run(),
    ),
  );
  if (result.meta.changes !== 1)
    throw new ExecutionStopped("Execution is no longer active");
}
