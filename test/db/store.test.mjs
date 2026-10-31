import assert from "node:assert/strict";
import { test } from "node:test";
import { initOrdo } from "../.build/core.mjs";
import { claimAttempt, getAttempt, getGoal, insertAttempt, insertGoal, updateAttempt, updateGoal } from "../../src/db/store.ts";
import { getGoalStatus } from "../../src/core/goal.ts";
import { TestDatabase } from "../fixtures.mjs";

test("Goal expiry is derived without a database update", async (t) => {
  const db = new TestDatabase(); t.after(() => db.close()); await initOrdo(db);
  const goal = await insertGoal(db, { shop: 1 }, 100, 1000);
  assert.equal(getGoalStatus(goal, 1099), "ready");
  assert.equal(getGoalStatus(goal, 1100), "expired");
  await updateGoal(db, goal.id, "completed", 1100);
  assert.equal((await getGoal(db, goal.id)).status, "ready");
  await updateGoal(db, goal.id, "completed", 1099);
  assert.equal(getGoalStatus(await getGoal(db, goal.id), 2000), "completed");
});

test("claim is atomic and terminal attempt results cannot be overwritten", async (t) => {
  const db = new TestDatabase(); t.after(() => db.close()); await initOrdo(db);
  const now = Date.now();
  const goal = await insertGoal(db, {}, 10000, now);
  await updateGoal(db, goal.id, "running", now);
  const attempt = await insertAttempt(db, goal.id, "extract", now);
  const claims = await Promise.all([claimAttempt(db, attempt.id, now), claimAttempt(db, attempt.id, now)]);
  assert.deepEqual(claims, [true, false]);
  await updateAttempt(db, attempt.id, { output: null, status: "completed", finishedAt: now });
  assert.equal((await getAttempt(db, attempt.id)).output, null);
  assert.equal(await updateAttempt(db, attempt.id, { status: "failed", output: {} }), false);
  assert.equal((await getAttempt(db, attempt.id)).status, "completed");
});

test("new attempts cannot be created for expired or terminal Goals", async (t) => {
  const db = new TestDatabase(); t.after(() => db.close()); await initOrdo(db);
  const goal = await insertGoal(db, {}, 10, 100);
  await updateGoal(db, goal.id, "running", 101);
  assert.equal(await insertAttempt(db, goal.id, "x", 110), null);
  await updateGoal(db, goal.id, "failed", 109);
  assert.equal(await insertAttempt(db, goal.id, "x", 109), null);
});
