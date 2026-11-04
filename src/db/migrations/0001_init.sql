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
  workflow_name TEXT,
  instance_id TEXT,
  input_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'ready',
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  finished_at INTEGER,
  error_json TEXT
);

CREATE UNIQUE INDEX cfordo_goals_workflow_instance
  ON cfordo_goals(workflow_name, instance_id)
  WHERE workflow_name IS NOT NULL AND instance_id IS NOT NULL;

-- One row per run, validate or evaluate action.
-- ready -> running -> completed / failed
-- Results are persisted before completion is notified to the Workflow.
-- SQL NULL means no accepted output is stored; JSON null is the text 'null'.
CREATE TABLE cfordo_attempts (
  id INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
  goal_id INTEGER NOT NULL REFERENCES cfordo_goals(id),
  step_name TEXT NOT NULL,
  worker_name TEXT NOT NULL,
  action TEXT,
  predecessor_id INTEGER REFERENCES cfordo_attempts(id),
  source_run_id INTEGER REFERENCES cfordo_attempts(id),
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

CREATE UNIQUE INDEX cfordo_attempts_first_action
  ON cfordo_attempts(goal_id, step_name)
  WHERE action IS NOT NULL AND predecessor_id IS NULL;
CREATE UNIQUE INDEX cfordo_attempts_next_action
  ON cfordo_attempts(predecessor_id)
  WHERE predecessor_id IS NOT NULL;
