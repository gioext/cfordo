import assert from "node:assert/strict";
import { test } from "node:test";
import { harness } from "../fixtures.mjs";

test("registered order and parallel barrier; context exposes params and result without shared execution state", { timeout: 3000 }, async (t) => {
  const h = await harness(t);
  const order = [];
  const gate = Promise.withResolvers();
  const step_init = { name: "init", run: async (ctx) => { order.push("init"); assert.deepEqual(ctx.params(), { shop: 7 }); assert.equal(ctx.result(), undefined); return { initialized: true }; } };
  const step_price = { name: "price", run: async () => { order.push("price-start"); await gate.promise; order.push("price-end"); return { price: 100 }; } };
  const step_hours = { name: "hours", run: async () => { order.push("hours-start"); gate.resolve(); return { hours: "9-5" }; } };
  const step_final = { name: "final", run: async (ctx) => {
    order.push("final");
    const completed = h.db.rows("cfordo_attempts", "goal_id=? AND status='completed'", ctx.goalId);
    assert.equal(completed.length, 3);
    return { done: true };
  } };
  h.workflow.step({ ...step_init, name: "initialize" });
  await h.workflow.parallel(async () => {
    h.workflow.step({ ...step_price, name: "price" });
    h.workflow.step({ ...step_hours, name: "hours" });
  });
  h.workflow.step({ ...step_final, name: "finalize" });
  assert.equal(await h.run({ shop: 7 }), "completed");
  assert.equal(order[0], "init"); assert.equal(order.at(-1), "final");
  assert.ok(order.indexOf("hours-start") < order.indexOf("price-end"));
  assert.equal(h.db.rows("cfordo_goals")[0].status, "completed");
  assert.ok(h.step.calls.filter((call) => call.config).every((call) => call.config.retries.limit === 0));
});

for (const [source, maximum] of [["run", 3], ["validate", 3], ["evaluate", 10]]) {
  test(`${source} failures stop at ${maximum} attempts across launches`, { timeout: 3000 }, async (t) => {
    const h = await harness(t);
    const contexts = [];
    let validations = 0, evaluations = 0;
    const step_extract = {
      name: "extract",
      run: async (ctx) => { contexts.push(ctx); if (source === "run") throw new Error("run error"); return { value: 1 }; },
      validate: async (ctx) => { validations++; return source === "validate" ? ctx.ng("validate NG") : ctx.ok(); },
    };
    h.workflow.step({ ...step_extract, name: "extract", evaluate: async (ctx) => { evaluations++; return source === "evaluate" ? ctx.ng("evaluate NG") : ctx.ok(); } });
    h.workflow.step({ ...step_extract, name: "must-not-run" });
    assert.equal(await h.run({}), "failed");
    const attempts = h.db.rows("cfordo_attempts");
    assert.equal(attempts.length, maximum);
    assert.ok(attempts.every((attempt) => attempt.step_name === "extract" && attempt.status === "failed"));
    assert.equal(contexts.length, maximum);
    assert.equal(contexts[0].feedback, undefined);
    if (source !== "run") assert.deepEqual(contexts[1].feedback, { source, reason: `${source} NG` });
    if (source === "run") assert.equal(validations, 0);
    if (source !== "evaluate") assert.equal(evaluations, 0);
    assert.equal(h.db.rows("cfordo_goals")[0].status, "failed");
  });
}

test("successful Validation checks do not consume retry budgets on Evaluation NG", { timeout: 3000 }, async (t) => {
  const h = await harness(t);
  let runs = 0, validations = 0, evaluations = 0;
  const step_extract = { name: "extract", run: async () => ({ count: ++runs }), validate: async (ctx) => { validations++; return ctx.ok(); } };
  h.workflow.step({ ...step_extract, name: "extract", evaluate: async (ctx) => ++evaluations < 10 ? ctx.ng("retry") : ctx.ok() });
  assert.equal(await h.run({}), "completed");
  assert.deepEqual([runs, validations, evaluations], [10, 10, 10]);
});

for (const source of ["validate", "evaluate"]) {
  test(`${source} exceptions retry only the failed check`, { timeout: 3000 }, async (t) => {
    const h = await harness(t);
    let runs = 0, checks = 0;
    const check = () => { if (++checks < 3) throw new Error("temporary check error"); };
    const step_extract = {
      name: "extract", run: async () => { runs++; return { value: 1 }; },
      validate: async (ctx) => { if (source === "validate") check(); return ctx.ok(); },
    };
    h.workflow.step({ ...step_extract, name: "extract", evaluate: async (ctx) => { if (source === "evaluate") check(); return ctx.ok(); } });
    assert.equal(await h.run({}), "completed");
    assert.equal(runs, 1); assert.equal(checks, 3);
    assert.equal(h.db.rows("cfordo_attempts").length, 3);
    if (source === "evaluate") assert.equal(h.sent.length, 1);
  });
}

test("exception budget does not reset when a later Evaluation NG restarts the Worker", { timeout: 3000 }, async (t) => {
  const h = await harness(t);
  let runs = 0, validations = 0;
  const step_extract = { name: "extract", run: async () => { runs++; return {}; }, validate: async (ctx) => {
    validations++;
    if (validations === 1 || validations === 2 || validations === 4) throw new Error("validation error");
    return ctx.ok();
  } };
  h.workflow.step({ ...step_extract, name: "extract", evaluate: async (ctx) => ctx.ng("evaluate NG") });
  assert.equal(await h.run({}), "failed");
  assert.equal(runs, 2); assert.equal(validations, 4);
  assert.equal(h.db.rows("cfordo_attempts").filter((row) => row.error_json !== null).length, 3);
});

test("a successful parallel sibling is not rerun", { timeout: 3000 }, async (t) => {
  const h = await harness(t);
  let price = 0, hours = 0;
  const step_price = { name: "price", run: async () => ({ value: ++price }), validate: async (ctx) => ctx.result().value < 3 ? ctx.ng("price NG") : ctx.ok() };
  const step_hours = { name: "hours", run: async () => ({ value: ++hours }) };
  await h.workflow.parallel(async () => { h.workflow.step({ ...step_price, name: "price" }); h.workflow.step({ ...step_hours, name: "hours" }); });
  assert.equal(await h.run({}), "completed");
  assert.equal(price, 3); assert.equal(hours, 1);
});

test("a missing run function is rejected before execution", async (t) => {
  const h = await harness(t);
  assert.throws(() => h.workflow.step({ name: "missing" }), /run function/);
  assert.equal(h.db.rows("cfordo_attempts").length, 0);
});

test("Workflow replay reuses checkpointed launches and evaluation", { timeout: 3000 }, async (t) => {
  const h = await harness(t);
  let runs = 0, evaluations = 0;
  const step_extract = { name: "extract", run: async () => ({ count: ++runs }) };
  const register = (ordo) => ordo.step({ ...step_extract, name: "extract", evaluate: async (ctx) => { evaluations++; return ctx.ok(); } });
  register(h.workflow);
  assert.equal(await h.run({}), "completed");
  const replay = h.newDefinition(); register(replay);
  assert.equal(await h.replay(replay, {}), "completed");
  assert.equal(runs, 1); assert.equal(evaluations, 1);
  assert.equal(h.db.rows("cfordo_goals").length, 1);
  assert.equal(h.db.rows("cfordo_attempts").length, 1);
});

test("late Worker output returns expired without updating the Goal or evaluating", { timeout: 3000 }, async (t) => {
  const original = Date.now; let now = original(); Date.now = () => now;
  t.after(() => { Date.now = original; });
  const h = await harness(t, { expiresIn: 100 });
  let evaluated = false;
  const step_extract = { name: "extract", run: async () => { now += 100; return { late: true }; } };
  h.workflow.step({ ...step_extract, name: "extract", evaluate: async (ctx) => { evaluated = true; return ctx.ok(); } });
  assert.equal(await h.run({}), "expired");
  assert.equal(evaluated, false);
  const goal = h.db.rows("cfordo_goals")[0];
  assert.equal(goal.status, "running"); assert.equal(goal.finished_at, null);
  assert.deepEqual(JSON.parse(h.db.rows("cfordo_attempts")[0].output_json), { late: true });
});

test("Queue dispatch errors use the same exception limit", { timeout: 3000 }, async (t) => {
  const h = await harness(t); h.runtime.failDispatch = 10;
  h.workflow.step({ name: "extract", run: async () => ({}) });
  assert.equal(await h.run({}), "failed");
  assert.equal(h.db.rows("cfordo_attempts").length, 3);
});

test("resuming an expired Workflow does not re-enter its cached event wait", { timeout: 3000 }, async (t) => {
  const original = Date.now; let now = original(); Date.now = () => now;
  t.after(() => { Date.now = original; });
  const h = await harness(t, { expiresIn: 100 });
  h.runtime.dropDelivery = true;
  h.workflow.step({ name: "extract", run: async () => ({}) });
  const waiting = h.run({});
  while (!h.step.calls.some((call) => call.options)) await Promise.resolve();
  now += 100;
  const replay = h.newDefinition();
  replay.step({ name: "extract", run: async () => ({}) });
  assert.equal(await h.replay(replay, {}), "expired");
  assert.equal(h.db.rows("cfordo_goals")[0].status, "running");
  const intent = h.sent[0];
  await h.hub.send({ type: `ordo-completed-${intent.attemptId}`, payload: { attemptId: intent.attemptId } });
  assert.equal(await waiting, "expired");
});
