-- Move to Cron orchestration and improvement iterations while preserving Goal and action history.
CREATE INDEX cfordo_goals_pending
  ON cfordo_goals(status, expires_at, id);

-- Keep Goals and action history; remove the obsolete orchestration identity.
DROP INDEX cfordo_goals_workflow_instance;
ALTER TABLE cfordo_goals DROP COLUMN workflow_name;
ALTER TABLE cfordo_goals DROP COLUMN instance_id;

CREATE TABLE cfordo_iterations (
  id INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
  goal_id INTEGER NOT NULL REFERENCES cfordo_goals(id),
  step_name TEXT NOT NULL,
  iteration INTEGER NOT NULL CHECK (iteration BETWEEN 1 AND 10),
  dispatch_status TEXT NOT NULL DEFAULT 'ready',
  dispatch_token TEXT,
  dispatch_until INTEGER,
  created_at INTEGER NOT NULL,
  UNIQUE (goal_id, step_name, iteration)
);
ALTER TABLE cfordo_attempts ADD COLUMN iteration_id INTEGER REFERENCES cfordo_iterations(id);
ALTER TABLE cfordo_attempts ADD COLUMN delivery INTEGER;
ALTER TABLE cfordo_attempts ADD COLUMN dispatch_token TEXT;
DROP INDEX cfordo_attempts_first_action;
DROP INDEX cfordo_attempts_next_action;
CREATE UNIQUE INDEX cfordo_attempts_first_action
  ON cfordo_attempts(goal_id, step_name)
  WHERE iteration_id IS NULL AND action IS NOT NULL AND predecessor_id IS NULL;
CREATE UNIQUE INDEX cfordo_attempts_next_action
  ON cfordo_attempts(predecessor_id)
  WHERE iteration_id IS NULL AND predecessor_id IS NOT NULL;
-- Append an action-less row when an execution finishes or the DLQ reports failure.
-- predecessor_id points to its final phase, and the new row ID records persistence order.
-- Legacy action-less rows have no iteration_id and are not final execution records.
CREATE INDEX cfordo_attempts_iteration_results
  ON cfordo_attempts(iteration_id, id)
  WHERE iteration_id IS NOT NULL AND action IS NULL;
