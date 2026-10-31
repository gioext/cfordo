import assert from "node:assert/strict";
import { test } from "node:test";
import { harness, queueBatch, queueMessage, seedAttempt } from "../fixtures.mjs";

test("saved results precede completion and notification retry does not rerun business code", { timeout: 3000 }, async (t) => {
  const h = await harness(t);
  h.hub.failBefore = 1;
  let runs = 0, checks = 0;
  const send = h.hub.send.bind(h.hub);
  h.hub.send = async (event) => {
    const row = h.db.rows("cfordo_attempts", "id=?", event.payload.attemptId)[0];
    assert.deepEqual(JSON.parse(row.output_json), { value: 1 });
    assert.deepEqual(JSON.parse(row.validation_json), { ok: true });
    return send(event);
  };
  const step_extract = { name: "extract", run: async () => { runs++; return { value: 1 }; }, validate: async (ctx) => { checks++; return ctx.ok(); } };
  h.workflow.step({ ...step_extract, name: "extract" });
  assert.equal(await h.run({}), "completed");
  await h.drain();
  assert.equal(runs, 1); assert.equal(checks, 1);
  assert.ok(h.delivered.some((message) => message.attempts === 2));
});

test("duplicate events cannot repeat evaluation or the following Step", { timeout: 3000 }, async (t) => {
  const h = await harness(t); h.hub.duplicate = true;
  let evaluations = 0, next = 0;
  const step_extract = { name: "extract", run: async () => ({ value: 1 }) };
  const step_next = { name: "next", run: async () => ({ count: ++next }) };
  h.workflow.step({ ...step_extract, name: "extract", evaluate: async (ctx) => ++evaluations === 1 ? ctx.ng("retry") : ctx.ok() });
  h.workflow.step({ ...step_next, name: "next" });
  assert.equal(await h.run({}), "completed");
  assert.equal(evaluations, 2); assert.equal(next, 1);
});

test("a lost sendEvent response cannot duplicate evaluation", { timeout: 3000 }, async (t) => {
  const h = await harness(t); h.hub.failAfter = 1;
  let runs = 0, evaluations = 0;
  const step_extract = { name: "extract", run: async () => ({ count: ++runs }) };
  h.workflow.step({ ...step_extract, name: "extract", evaluate: async (ctx) => { evaluations++; return ctx.ok(); } });
  assert.equal(await h.run({}), "completed");
  await h.drain();
  assert.equal(runs, 1); assert.equal(evaluations, 1);
});

test("concurrent deliveries of one Attempt execute the wrapper once", async (t) => {
  const h = await harness(t);
  let runs = 0;
  h.consumer.step({ name: "extract", run: async () => { runs++; await Promise.resolve(); return {}; } });
  const { attemptId } = seedAttempt(h.db);
  const first = queueMessage(h.intent(attemptId));
  const second = queueMessage(h.intent(attemptId));
  await h.consumer.queue(queueBatch([first, second], "any-queue"), {}, { waitUntil() {} });
  assert.equal(runs, 1);
  assert.equal(first.acknowledged, true); assert.equal(second.acknowledged, true);
});

test("a failed result save does not emit completion", async (t) => {
  const h = await harness(t);
  h.consumer.step({ name: "extract", run: async () => ({ value: 1 }) });
  const { attemptId } = seedAttempt(h.db);
  h.db.before = (sql) => { if (sql.startsWith("UPDATE cfordo_attempts SET output_json")) throw new Error("D1 unavailable"); };
  const message = queueMessage(h.intent(attemptId));
  await h.consumer.queue(queueBatch([message]), {}, { waitUntil() {} });
  assert.equal(message.retried, true);
  assert.equal(h.hub.events.length, 0);
  assert.equal(h.db.rows("cfordo_attempts")[0].output_json, null);
});

test("JSON null is a valid return; undefined is not silently converted", { timeout: 3000 }, async (t) => {
  const h = await harness(t);
  const step_null = { name: "null", run: async () => null };
  const step_void = { name: "void", run: async () => undefined };
  h.workflow.step({ ...step_null, name: "null" });
  h.workflow.step({ ...step_void, name: "void" });
  assert.equal(await h.run({}), "failed");
  const attempts = h.db.rows("cfordo_attempts");
  assert.equal(attempts[0].output_json, "null");
  assert.equal(attempts.filter((row) => row.step_name === "void").length, 3);
  assert.ok(attempts.slice(1).every((row) => row.output_json === null));
});

test("business results are stored without schema transformation", async (t) => {
  const h = await harness(t);
  const step_extract = { name: "extract", run: async () => "12", validate: async (ctx) => {
    assert.equal(ctx.result(), "12"); return ctx.ok();
  } };
  h.workflow.step({ ...step_extract, name: "extract", evaluate: async (ctx) => {
    assert.equal(ctx.result(), "12"); assert.deepEqual(ctx.params(), {}); return ctx.ok();
  } });
  assert.equal(await h.run({}), "completed");
  assert.equal(h.db.rows("cfordo_attempts")[0].output_json, '"12"');
});

test("expired queued work is acknowledged without invoking business code", async (t) => {
  const h = await harness(t);
  let runs = 0;
  h.consumer.step({ name: "extract", run: async () => { runs++; return {}; } });
  const { attemptId } = seedAttempt(h.db, { expiresAt: Date.now() - 1 });
  const message = queueMessage(h.intent(attemptId));
  await h.consumer.queue(queueBatch([message]), {}, { waitUntil() {} });
  assert.equal(runs, 0); assert.equal(message.acknowledged, true);
  assert.equal(h.db.rows("cfordo_goals")[0].status, "running");
});

test("malformed Intent metadata cannot invoke a Worker", async (t) => {
  const h = await harness(t);
  let runs = 0;
  h.consumer.step({ name: "extract", run: async () => { runs++; return {}; } });
  const { attemptId } = seedAttempt(h.db);
  for (const extra of [
    { feedback: { source: ["output"], reason: "bad source" } },
    { resume: { phase: ["validate"], attemptId } },
  ]) {
    const message = queueMessage(h.intent(attemptId, extra));
    await h.consumer.queue(queueBatch([message]), {}, { waitUntil() {} });
    assert.equal(message.retried, true);
  }
  assert.equal(runs, 0);
  assert.equal(h.hub.events.length, 0);
});

test("an unregistered Step message records a fatal configuration failure without invoking another Step", async (t) => {
  const h = await harness(t);
  let runs = 0;
  h.consumer.step({ name: "registered", run: async () => { runs++; return {}; } });
  const { attemptId } = seedAttempt(h.db, { stepName: "missing" });
  const message = queueMessage(h.intent(attemptId));
  await h.consumer.queue(queueBatch([message]), {}, { waitUntil() {} });
  const error = JSON.parse(h.db.rows("cfordo_attempts")[0].error_json);
  assert.equal(error.fatal, true);
  assert.equal(error.source, "configuration");
  assert.equal(message.acknowledged, true);
  assert.equal(runs, 0);
});
