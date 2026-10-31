-- cfordo: initial D1 migration (version 1).
-- Timestamps are Unix epoch milliseconds supplied by the caller.
-- This file defines storage only; it does not schedule retries or timeouts.

-- id is the explicitly applied schema version number.
CREATE TABLE cfordo_schema_versions (
  id INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
  applied_at INTEGER NOT NULL
);

-- Goal creates the record; Planner updates its status.
-- ready -> running -> completed / failed
-- expired is derived from status and expires_at; it is not stored in status.
CREATE TABLE cfordo_goals (
  id INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
  input_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'ready',
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  finished_at INTEGER
);

-- One row per Engine launch. Only the Engine inserts launch records.
-- Worker and Engine update the record.
-- ready -> running -> validating -> evaluating -> completed / failed
-- Worker sets running before run and validating before output/Validation.
-- Engine sets evaluating before Evaluation and completed after success.
-- Engine alone finalizes completed/failed after reading persisted results.
-- The Engine allocates id in launch order; id is WorkerContext.attemptId.
-- The Worker wrapper writes business output, output checks and Validation.
-- The Worker wrapper sends a completion event only after persisting results.
-- The event wakes the Engine, which reads DB values and records Evaluation.
-- Check results are {ok, reason}; error_json includes the failing operation.
-- SQL NULL means no accepted output is stored; JSON null is the text 'null'.
CREATE TABLE cfordo_attempts (
  id INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
  goal_id INTEGER NOT NULL REFERENCES cfordo_goals(id),
  step_name TEXT NOT NULL,
  worker_name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'ready',
  output_json TEXT,
  output_check_json TEXT,
  validation_json TEXT,
  evaluation_json TEXT,
  error_json TEXT,
  created_at INTEGER NOT NULL,
  finished_at INTEGER
);

CREATE INDEX cfordo_attempts_goal_step_order
  ON cfordo_attempts(goal_id, step_name, id);

-- Update the active status before executing its corresponding processing.
-- Persist terminal status and its associated results in the same UPDATE.
-- State reads use the latest id for a Goal/Step; prior launches remain history.
-- Feedback is assembled from prior check results for the same Goal/Step.
-- A new Engine launch inserts a new row instead of resetting a prior row.
