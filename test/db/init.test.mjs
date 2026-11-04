import assert from "node:assert/strict";
import { test } from "node:test";
import { initOrdo } from "../.build/core.mjs";
import { TestDatabase, seedAttempt } from "../fixtures.mjs";

test("the initial migration applies once and preserves action history", async (t) => {
  const db = new TestDatabase();
  t.after(() => db.close());
  await initOrdo(db);
  const { attemptId } = seedAttempt(db);
  db.sqlite
    .prepare("UPDATE cfordo_attempts SET output_json = '7' WHERE id = ?")
    .run(attemptId);
  const goals = db.rows("cfordo_goals");
  const attempts = db.rows("cfordo_attempts");
  const versions = db.rows("cfordo_schema_versions");
  await initOrdo(db);
  assert.deepEqual(
    versions.map((row) => row.id),
    [1],
  );
  assert.deepEqual(db.rows("cfordo_schema_versions"), versions);
  assert.deepEqual(db.rows("cfordo_goals"), goals);
  assert.deepEqual(db.rows("cfordo_attempts"), attempts);
  assert.deepEqual(db.sqlite.prepare("PRAGMA foreign_key_check").all(), []);
});

test("concurrent initialization converges", async (t) => {
  const db = new TestDatabase();
  t.after(() => db.close());
  await Promise.all([initOrdo(db), initOrdo(db), initOrdo(db)]);
  assert.equal(db.rows("cfordo_schema_versions").length, 1);
});

test("migration failure rolls back the entire schema and can be retried", async (t) => {
  const db = new TestDatabase();
  t.after(() => db.close());
  db.before = (sql) => {
    if (sql.startsWith("CREATE UNIQUE INDEX cfordo_attempts_next_action"))
      throw new Error("migration failed");
  };
  await assert.rejects(initOrdo(db), /migration failed/);
  assert.deepEqual(
    db.sqlite
      .prepare("SELECT name FROM sqlite_master WHERE name LIKE 'cfordo_%'")
      .all(),
    [],
  );
  db.before = undefined;
  await initOrdo(db);
  assert.deepEqual(
    db.rows("cfordo_schema_versions").map((row) => row.id),
    [1],
  );
  seedAttempt(db);
  assert.equal(db.rows("cfordo_attempts").length, 1);
});

test("a newer database is rejected without modification", async (t) => {
  const db = new TestDatabase();
  t.after(() => db.close());
  await initOrdo(db);
  db.sqlite.prepare("INSERT INTO cfordo_schema_versions VALUES (2,1)").run();
  const versions = db.rows("cfordo_schema_versions");
  await assert.rejects(initOrdo(db), /unsupported/);
  assert.deepEqual(db.rows("cfordo_schema_versions"), versions);
});
