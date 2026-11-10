CREATE TABLE IF NOT EXISTS {{prefix}}goals (
  id INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
  input_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'ready',
  created_at INTEGER NOT NULL,
  finished_at INTEGER
);

CREATE TABLE IF NOT EXISTS {{prefix}}attempts (
  id INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
  goal_id INTEGER,
  step_name TEXT,
  action TEXT,
  predecessor_id INTEGER,
  status TEXT,
  output_json TEXT,
  error_json TEXT,
  created_at INTEGER NOT NULL,
  finished_at INTEGER
);

CREATE INDEX IF NOT EXISTS {{prefix}}goals_pending
  ON {{prefix}}goals(status, id);
CREATE UNIQUE INDEX IF NOT EXISTS {{prefix}}attempts_root
  ON {{prefix}}attempts(goal_id, step_name) WHERE predecessor_id IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS {{prefix}}attempts_next_delivery
  ON {{prefix}}attempts(predecessor_id) WHERE action IS NULL AND predecessor_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS {{prefix}}attempts_next_action
  ON {{prefix}}attempts(predecessor_id) WHERE action IS NOT NULL;
CREATE INDEX IF NOT EXISTS {{prefix}}attempts_predecessor
  ON {{prefix}}attempts(predecessor_id);
