import assert from "node:assert/strict";
import { test } from "node:test";
import { initOrdo } from "../.build/core.mjs";
import {
  claimAttempt,
  ensureAttempt,
  insertGoal,
  attachWorkflow,
  listGoals,
  failAttempt,
  finishAttempt,
  getAttempt,
  getGoal,
  listAttempts,
  saveOutcome,
  updateGoal,
} from "../../src/db/store.ts";
import { getGoalStatus } from "../.build/core.mjs";
import { TestDatabase } from "../fixtures.mjs";

async function database(t) {
  const db = new TestDatabase();
  t.after(() => db.close());
  await initOrdo(db);
  return db;
}

test("Goal IDs are allocated before creation and Workflow association is idempotent", async (t) => {
  const db = await database(t);
  const a = await insertGoal(db, { value: 1 }, 1000, 100);
  const b = await insertGoal(db, { value: 2 }, 1000, 100);
  assert.equal(a.id, 1);
  assert.equal(b.id, 2);
  assert.equal(a.instanceId, null);
  await Promise.all([
    attachWorkflow(db, a.id, "one"),
    attachWorkflow(db, a.id, "one", "flow"),
  ]);
  await attachWorkflow(db, a.id, "one");
  const saved = await getGoal(db, a.id);
  assert.equal(saved.workflowName, "flow");
  assert.equal(saved.instanceId, "one");
  assert.deepEqual(saved.input, { value: 1 });
  await assert.rejects(attachWorkflow(db, a.id, "two"), /different/);
  await assert.rejects(attachWorkflow(db, a.id, "one", "other"), /different/);
  await assert.rejects(attachWorkflow(db, 99, "one"), /not found/);
  assert.deepEqual(
    (await listGoals(db)).map((g) => g.id),
    [2, 1],
  );
});

test("Goal expiration is derived and cannot overwrite a terminal Goal", async (t) => {
  const db = await database(t);
  const goal = await insertGoal(db, {}, 100, 1000);
  assert.equal(getGoalStatus(goal, 1099), "ready");
  assert.equal(getGoalStatus(goal, 1100), "expired");
  await updateGoal(db, goal.id, "completed", undefined, 1100);
  assert.equal((await getGoal(db, goal.id)).status, "ready");
  await updateGoal(db, goal.id, "completed", undefined, 1099);
  assert.equal(getGoalStatus(await getGoal(db, goal.id), 2000), "completed");
});

test("root and successor creation are idempotent and retain an immutable source run reference", async (t) => {
  const db = await database(t);
  const now = Date.now();
  const goal = await insertGoal(db, {}, 10000, now);
  await updateGoal(db, goal.id, "running");
  await Promise.all([
    ensureAttempt(db, goal.id, "job", "run", null, null),
    ensureAttempt(db, goal.id, "job", "run", null, null),
  ]);
  const root = (await listAttempts(db, goal.id))[0];
  await claimAttempt(db, root.id);
  await saveOutcome(db, root.id, "run", { value: 7 });
  await finishAttempt(db, root.id);
  await Promise.all([
    ensureAttempt(db, goal.id, "job", "validate", root.id, root.id),
    ensureAttempt(db, goal.id, "job", "validate", root.id, root.id),
  ]);
  const rows = await listAttempts(db, goal.id);
  assert.equal(rows.length, 2);
  assert.equal(rows[1].predecessorId, root.id);
  assert.equal(rows[1].sourceRunId, root.id);
});

test("claims are atomic, drafts may be overwritten, and only saved outcomes can be finalized", async (t) => {
  const db = await database(t);
  const goal = await insertGoal(db, {}, 10000);
  await updateGoal(db, goal.id, "running");
  await ensureAttempt(db, goal.id, "job", "run", null, null);
  const a = (await listAttempts(db, goal.id))[0];
  assert.deepEqual(
    await Promise.all([claimAttempt(db, a.id), claimAttempt(db, a.id)]),
    [true, false],
  );
  await assert.rejects(finishAttempt(db, a.id), /without a saved/);
  await saveOutcome(db, a.id, "run", 1);
  await saveOutcome(db, a.id, "run", 2);
  await finishAttempt(db, a.id);
  await assert.rejects(saveOutcome(db, a.id, "run", 3), /not running/);
  await failAttempt(db, a.id, {
    source: "run",
    name: "Error",
    message: "late",
  });
  const row = await getAttempt(db, a.id);
  assert.equal(row.status, "completed");
  assert.equal(row.output, 2);
  assert.equal(row.error, null);
});

test("new actions cannot start on expired or failed Goals", async (t) => {
  const db = await database(t);
  const goal = await insertGoal(db, {}, 10, 100);
  await updateGoal(db, goal.id, "running", undefined, 101);
  await ensureAttempt(db, goal.id, "job", "run", null, null, 110);
  assert.equal((await listAttempts(db, goal.id)).length, 0);
  await updateGoal(db, goal.id, "failed", undefined, 109);
  await ensureAttempt(db, goal.id, "job", "run", null, null, 109);
  assert.equal((await listAttempts(db, goal.id)).length, 0);
});
