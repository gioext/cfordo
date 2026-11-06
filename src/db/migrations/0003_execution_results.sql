-- Keep scheduling records separate from each execution's final result.
ALTER TABLE cfordo_attempts ADD COLUMN dispatch_token TEXT;
UPDATE cfordo_attempts SET dispatch_token = (
  SELECT dispatch_token FROM cfordo_iterations WHERE id = iteration_id
) WHERE iteration_id IS NOT NULL;

-- Two deliveries may have the same attempt number but must have separate history.
DROP INDEX cfordo_attempts_delivery_action;

-- IDs are allocated when the final result is saved, not when execution starts.
CREATE TABLE cfordo_iteration_results (
  id INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
  iteration_id INTEGER NOT NULL REFERENCES cfordo_iterations(id),
  attempt_id INTEGER REFERENCES cfordo_attempts(id),
  error_json TEXT,
  finished_at INTEGER NOT NULL
);
CREATE INDEX cfordo_iteration_results_order
  ON cfordo_iteration_results(iteration_id, id);

-- Preserve results of the previous, single-execution-per-iteration format.
INSERT INTO cfordo_iteration_results (iteration_id, attempt_id, error_json, finished_at)
SELECT i.id,
  (SELECT a.id FROM cfordo_attempts a
   WHERE a.iteration_id = i.id AND a.delivery = i.delivery ORDER BY a.id DESC LIMIT 1),
  CASE WHEN i.status = 'failed' THEN i.error_json ELSE NULL END,
  COALESCE(i.finished_at, i.created_at)
FROM cfordo_iterations i WHERE i.status IN ('completed', 'failed')
ORDER BY COALESCE(i.finished_at, i.created_at), i.id;

UPDATE cfordo_iterations SET status = 'queued' WHERE status NOT IN ('ready', 'sending');
ALTER TABLE cfordo_iterations RENAME COLUMN status TO dispatch_status;
ALTER TABLE cfordo_iterations DROP COLUMN message_id;
ALTER TABLE cfordo_iterations DROP COLUMN delivery;
ALTER TABLE cfordo_iterations DROP COLUMN token;
ALTER TABLE cfordo_iterations DROP COLUMN error_json;
ALTER TABLE cfordo_iterations DROP COLUMN finished_at;
