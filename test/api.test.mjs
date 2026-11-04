import assert from "node:assert/strict";
import { test } from "node:test";
import { createApi } from "./.build/core.mjs";
import { harness, seedAttempt } from "./fixtures.mjs";
import { attachWorkflow, getGoal, insertGoal } from "../src/db/store.ts";

const ctx = { waitUntil() {}, passThroughOnException() {} };
const post = (body) => ({
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
});
function api(h) {
  const app = createApi(async () => h.workflow);
  return (path, options) =>
    app.request(`https://test${path}`, options, h.env, ctx);
}
const run = async (c) => c.complete(c.input().params);
const ok = async (c) => c.ok();

test("HTTP creates a persisted Goal before starting and returns its numeric ID and Location", async (t) => {
  const h = await harness(t, { initialize: false });
  h.workflow.step({ name: "job", run });
  let called = 0;
  h.env.WORKFLOW.create = async ({ params }) => {
    called++;
    const goal = await getGoal(h.db, params.goalId);
    assert.deepEqual(goal.input, { value: 7 });
    assert.equal(goal.status, "ready");
    assert.equal(goal.instanceId, null);
    return { id: "generated-by-cloudflare" };
  };
  const request = api(h);
  const response = await request("/_ordo/goals", post({ value: 7 }));
  assert.equal(response.status, 202);
  assert.deepEqual(await response.json(), { goalId: 1 });
  assert.equal(response.headers.get("Location"), "/_ordo/goals/1");
  assert.equal(called, 1);
  const detail = await (await request("/_ordo/goals/1")).json();
  assert.equal(detail.goalId, 1);
  assert.equal(detail.status, "ready");
  assert.equal(detail.expiresAt - detail.createdAt, 86400000);
  assert.deepEqual(detail.results[0], {
    stepName: "job",
    status: "ready",
    action: null,
    output: null,
    validation: null,
    evaluation: null,
    error: null,
    createdAt: null,
    finishedAt: null,
    executions: [],
  });
});

test("invalid JSON and IDs return 400, missing Goals and routes return 404 without creating Goals", async (t) => {
  const h = await harness(t);
  h.workflow.step({ name: "job", run });
  const request = api(h);
  for (const body of ["{", "", "1e999"])
    assert.equal(
      (await request("/_ordo/goals", { method: "POST", body })).status,
      400,
    );
  for (const id of ["0", "-1", "1.5", "x", "1e2", "9007199254740992"])
    assert.equal((await request(`/_ordo/goals/${id}`)).status, 400);
  assert.equal((await request("/_ordo/goals/99")).status, 404);
  assert.equal((await request("/other")).status, 404);
  assert.deepEqual(await (await request("/_ordo/goals")).json(), []);
});

test("a Workflow can finish before create returns without losing its association or result", async (t) => {
  const h = await harness(t);
  h.workflow.step({ name: "job", run, validate: ok, evaluate: ok });
  h.env.WORKFLOW.create = async ({ params }) => {
    await h.workflow.run({ ...h.runtime.event, payload: params }, h.step);
    return { id: h.runtime.event.instanceId };
  };
  const request = api(h);
  const response = await request("/_ordo/goals", post({ value: 7 }));
  assert.equal(response.status, 202);
  const detail = await (await request("/_ordo/goals/1")).json();
  assert.equal(detail.status, "completed");
  assert.deepEqual(detail.input, { value: 7 });
  const result = detail.results[0];
  assert.equal(result.status, "completed");
  assert.equal(result.action, null);
  assert.deepEqual(result.output, { value: 7 });
  assert.deepEqual(result.validation, { ok: true });
  assert.deepEqual(result.evaluation, { ok: true });
  assert.deepEqual(
    result.executions.map((e) => e.action),
    ["run", "validate", "evaluate"],
  );
  assert.deepEqual(
    result.executions.map((e) => e.sourceRunId),
    [null, 1, 1],
  );
  assert.equal("attempts" in result, false);
  assert.ok(
    result.executions.every(
      (e) => e.status === "completed" && e.finishedAt !== null,
    ),
  );
  const rows = await (await request("/_ordo/goals")).json();
  const { executions, ...withoutHistory } = result;
  assert.deepEqual(rows, [{ ...detail, results: [withoutHistory] }]);
});

test("list returns every Goal newest first, including input and per-step results", async (t) => {
  const h = await harness(t);
  h.workflow.step({ name: "job", run });
  for (let value = 0; value < 25; value++)
    await insertGoal(h.db, { value }, 10000);
  const rows = await (await api(h)("/_ordo/goals")).json();
  assert.equal(rows.length, 25);
  assert.equal(rows[0].goalId, 25);
  assert.deepEqual(rows[0].input, { value: 24 });
  assert.equal(rows.at(-1).goalId, 1);
  assert.ok(
    rows.every(
      (row) =>
        row.results[0].stepName === "job" && !("executions" in row.results[0]),
    ),
  );
});

test("lost create response returns 503 with a queryable Goal, and the Workflow may still complete it", async (t) => {
  const h = await harness(t);
  h.workflow.step({ name: "job", run });
  h.env.WORKFLOW.create = async ({ params }) => {
    await attachWorkflow(h.db, params.goalId, "workflow-1", "test-workflow");
    throw new Error("response lost");
  };
  const request = api(h);
  const response = await request("/_ordo/goals", post({ value: 7 }));
  assert.equal(response.status, 503);
  assert.equal((await response.json()).goalId, 1);
  assert.equal((await getGoal(h.db, 1)).status, "ready");
  await h.workflow.run({ ...h.runtime.event, payload: { goalId: 1 } }, h.step);
  assert.equal(
    (await (await request("/_ordo/goals/1")).json()).status,
    "completed",
  );
});

test("a failed launch stays queryable and expires without inventing a successful start", async (t) => {
  const h = await harness(t);
  h.workflow.step({ name: "job", run });
  h.env.WORKFLOW.create = async () => {
    throw new Error("network unavailable");
  };
  const request = api(h);
  assert.equal((await request("/_ordo/goals", post(null))).status, 503);
  h.db.sqlite
    .prepare("UPDATE cfordo_goals SET expires_at = 1 WHERE id = 1")
    .run();
  const detail = await (await request("/_ordo/goals/1")).json();
  assert.equal(detail.status, "expired");
  assert.equal(detail.finishedAt, null);
  assert.equal(h.db.rows("cfordo_attempts").length, 0);
});

test("platform termination and read failure are distinguished from persisted business state", async (t) => {
  const h = await harness(t);
  h.workflow.step({ name: "job", run });
  const { goalId } = seedAttempt(h.db, { stepName: "job" });
  h.env.WORKFLOW.get = async () => ({
    status: async () => ({ status: "terminated" }),
  });
  const request = api(h);
  let response = await request(`/_ordo/goals/${goalId}`);
  assert.equal(response.status, 200);
  assert.equal((await response.json()).status, "failed");
  assert.equal((await getGoal(h.db, goalId)).status, "running");
  h.env.WORKFLOW.get = async () => {
    throw new Error("offline");
  };
  response = await request(`/_ordo/goals/${goalId}`);
  assert.equal(response.status, 503);
  assert.equal((await getGoal(h.db, goalId)).status, "running");
});

test("status reloads D1 after platform completion instead of reporting a stale failure", async (t) => {
  const h = await harness(t);
  h.workflow.step({ name: "job", run });
  const { goalId } = seedAttempt(h.db, { stepName: "job" });
  h.env.WORKFLOW.get = async () => ({
    status: async () => {
      h.db.sqlite
        .prepare("UPDATE cfordo_goals SET status='completed' WHERE id=?")
        .run(goalId);
      h.db.sqlite
        .prepare(
          "UPDATE cfordo_attempts SET status='completed', output_json='7' WHERE goal_id=?",
        )
        .run(goalId);
      return { status: "complete" };
    },
  });
  const detail = await (await api(h)(`/_ordo/goals/${goalId}`)).json();
  assert.equal(detail.status, "completed");
  assert.equal(detail.error, null);
  assert.equal(detail.results[0].output, 7);
});

test("a rerun never pairs the previous output/checks with the new run", async (t) => {
  const h = await harness(t);
  const gate = Promise.withResolvers();
  const entered = Promise.withResolvers();
  t.after(() => gate.resolve());
  let runs = 0;
  h.workflow.step({
    name: "job",
    run: async (c) => {
      if (++runs === 2) {
        entered.resolve();
        await gate.promise;
      }
      await c.complete({ run: runs });
    },
    validate: ok,
    evaluate: async (c) => {
      if (runs === 1) await c.ng("again");
      else await c.ok();
    },
  });
  const work = h.run({});
  await entered.promise;
  const request = api(h);
  const current = (await (await request("/_ordo/goals/1")).json()).results[0];
  assert.equal(current.status, "running");
  assert.equal(current.action, "run");
  assert.equal(current.output, null);
  assert.equal(current.validation, null);
  assert.equal(current.evaluation, null);
  assert.equal(current.executions.length, 4);
  assert.deepEqual(current.executions[2].verdict, {
    ok: false,
    reason: "again",
  });
  gate.resolve();
  await work;
  const final = (await (await request("/_ordo/goals/1")).json()).results[0];
  assert.equal(final.executions.length, 6);
  assert.deepEqual(final.output, { run: 2 });
  assert.deepEqual(final.evaluation, { ok: true });
});

test("business rejection exposes its reason and complete history with HTTP 200", async (t) => {
  const h = await harness(t);
  h.workflow.step({
    name: "job",
    run,
    validate: async (c) => c.ng("invalid result"),
  });
  await h.run({});
  const response = await api(h)("/_ordo/goals/1");
  assert.equal(response.status, 200);
  const detail = await response.json();
  assert.equal(detail.status, "failed");
  assert.equal(detail.error.message, "invalid result");
  assert.equal(detail.results[0].status, "failed");
  assert.equal(detail.results[0].executions.length, 6);
});

test("late output remains visible in history without being published as a successful step", async (t) => {
  const original = Date.now;
  let now = original();
  Date.now = () => now;
  t.after(() => {
    Date.now = original;
  });
  const h = await harness(t, { expiresIn: 100 });
  h.workflow.step({
    name: "job",
    run: async (c) => {
      now += 100;
      await c.complete({ late: true });
    },
  });
  await h.run({});
  const detail = await (await api(h)("/_ordo/goals/1")).json();
  assert.equal(detail.status, "expired");
  assert.equal(detail.results[0].status, "expired");
  assert.equal(detail.results[0].finishedAt, null);
  assert.deepEqual(detail.results[0].executions[0].output, { late: true });
});

test("Goal errors identify the exhausted step, not a different step's transient exception", async (t) => {
  const h = await harness(t);
  h.workflow.step({ name: "transient", run });
  h.workflow.step({ name: "fatal", run });
  const { goalId } = seedAttempt(h.db, { stepName: "transient" });
  seedAttempt(h.db, { goalId, stepName: "fatal" });
  h.db.sqlite
    .prepare("UPDATE cfordo_goals SET status='failed' WHERE id=?")
    .run(goalId);
  h.db.sqlite
    .prepare(
      "UPDATE cfordo_attempts SET status='failed',error_json=? WHERE step_name='transient'",
    )
    .run(
      JSON.stringify({ source: "run", name: "Error", message: "retryable" }),
    );
  h.db.sqlite
    .prepare(
      "UPDATE cfordo_attempts SET status='failed',error_json=? WHERE step_name='fatal'",
    )
    .run(
      JSON.stringify({
        source: "configuration",
        name: "Error",
        message: "missing handler",
        fatal: true,
      }),
    );
  const detail = await (await api(h)(`/_ordo/goals/${goalId}`)).json();
  assert.equal(detail.error.message, "missing handler");
  assert.equal(detail.results[0].error.message, "retryable");
});
