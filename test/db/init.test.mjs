import assert from "node:assert/strict";
import { test } from "node:test";
import { initOrdo } from "../.build/core.mjs";
import { TestDatabase } from "../fixtures.mjs";

test("initOrdo applies migrations once and preserves existing data", async (t) => {
  const db = new TestDatabase();
  t.after(() => db.close());
  await initOrdo(db);
  db.sqlite
    .prepare(
      "INSERT INTO cfordo_goals (input_json,created_at,expires_at) VALUES ('{}',1,100)",
    )
    .run();
  await initOrdo(db);
  assert.deepEqual(
    db.rows("cfordo_schema_versions").map((row) => row.id),
    [1],
  );
  assert.equal(db.rows("cfordo_goals").length, 1);
  assert.deepEqual(db.sqlite.prepare("PRAGMA foreign_key_check").all(), []);
});

test("concurrent init calls converge on one migration", async (t) => {
  const db = new TestDatabase();
  t.after(() => db.close());
  await Promise.all([initOrdo(db), initOrdo(db), initOrdo(db)]);
  assert.equal(db.rows("cfordo_schema_versions").length, 1);
});

test("migration failure rolls back tables and does not mark the version applied", async (t) => {
  const db = new TestDatabase();
  t.after(() => db.close());
  db.before = (sql) => {
    if (sql.startsWith("CREATE INDEX"))
      throw new Error("simulated migration failure");
  };
  await assert.rejects(initOrdo(db), /simulated migration failure/);
  assert.equal(
    db.sqlite
      .prepare(
        "SELECT count(*) AS n FROM sqlite_master WHERE name LIKE 'cfordo_%'",
      )
      .get().n,
    0,
  );
  db.before = undefined;
  await initOrdo(db);
  assert.equal(db.rows("cfordo_schema_versions").length, 1);
});

test("a newer database is rejected without modification", async (t) => {
  const db = new TestDatabase();
  t.after(() => db.close());
  await initOrdo(db);
  db.sqlite.prepare("INSERT INTO cfordo_schema_versions VALUES (2,1)").run();
  await assert.rejects(initOrdo(db), /unsupported/);
  assert.equal(db.rows("cfordo_schema_versions").length, 2);
});
