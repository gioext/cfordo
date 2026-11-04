import assert from "node:assert/strict";
import { test } from "node:test";
import {
  harness,
  queueBatch,
  queueMessage,
  seedAttempt,
} from "../fixtures.mjs";

const run = async (ctx) => {
  await ctx.complete({ value: 7 });
};
const ok = async (ctx) => {
  await ctx.ok();
};

test("saved terminal records precede notification and notification failure only retries notification", async (t) => {
  const h = await harness(t);
  h.hub.failBefore = 1;
  let runs = 0,
    checks = 0;
  const send = h.hub.send.bind(h.hub);
  h.hub.send = async (event) => {
    const id = Number(event.type.replace("ordo-completed-", ""));
    assert.equal(
      h.db.rows("cfordo_attempts", "id=?", id)[0].status,
      "completed",
    );
    assert.equal(event.payload, null);
    return send(event);
  };
  h.workflow.step({
    name: "job",
    run: async (ctx) => {
      runs++;
      await ctx.complete({});
    },
    validate: async (ctx) => {
      checks++;
      await ctx.ok();
    },
    evaluate: ok,
  });
  await h.run({});
  await h.drain();
  assert.equal(await h.status(), "completed");
  assert.equal(runs, 1);
  assert.equal(checks, 1);
  assert.ok(h.delivered.some((m) => m.attempts === 2));
});

test("duplicate signals and a lost notification response cannot repeat actions or later steps", async (t) => {
  const h = await harness(t);
  h.hub.duplicate = true;
  h.hub.failAfter = 1;
  let runs = 0,
    evaluations = 0,
    last = 0;
  h.workflow.step({
    name: "job",
    run: async (ctx) => {
      runs++;
      await ctx.complete(7);
    },
    evaluate: async (ctx) => {
      evaluations++;
      await ctx.ok();
    },
  });
  h.workflow.step({
    name: "last",
    run: async (ctx) => {
      last++;
      await ctx.complete(null);
    },
  });
  await h.run({});
  await h.drain();
  assert.equal(await h.status(), "completed");
  assert.deepEqual([runs, evaluations, last], [1, 1, 1]);
});

test("concurrent deliveries cannot execute the same action twice", async (t) => {
  const h = await harness(t);
  const gate = Promise.withResolvers();
  const started = Promise.withResolvers();
  let runs = 0;
  h.consumer.step({
    name: "extract",
    run: async (ctx) => {
      runs++;
      started.resolve();
      await gate.promise;
      await ctx.complete({});
    },
  });
  const { attemptId } = seedAttempt(h.db);
  const first = queueMessage(h.intent(attemptId));
  const duplicate = queueMessage(h.intent(attemptId));
  const pending = h.consumer.queue(queueBatch([first]), {}, { waitUntil() {} });
  await started.promise;
  await h.consumer.queue(queueBatch([duplicate]), {}, { waitUntil() {} });
  assert.equal(duplicate.retried, true);
  gate.resolve();
  await pending;
  const redelivery = queueMessage(h.intent(attemptId), 2);
  await h.consumer.queue(queueBatch([redelivery]), {}, { waitUntil() {} });
  assert.equal(redelivery.acknowledged, true);
  assert.equal(runs, 1);
});

test("result persistence failure does not claim successful completion", async (t) => {
  const h = await harness(t);
  h.consumer.step({ name: "extract", run });
  const { attemptId } = seedAttempt(h.db);
  h.db.before = (sql) => {
    if (sql.startsWith("UPDATE cfordo_attempts SET output_json"))
      throw new Error("save failed");
  };
  const message = queueMessage(h.intent(attemptId));
  await h.consumer.queue(queueBatch([message]), {}, { waitUntil() {} });
  const row = h.db.rows("cfordo_attempts")[0];
  assert.equal(row.status, "failed");
  assert.equal(row.output_json, null);
  assert.equal(JSON.parse(row.error_json).message, "save failed");
  assert.equal(message.acknowledged, true);
});

test("when even the failure record cannot be saved, Queue retries and no notification is emitted", async (t) => {
  const h = await harness(t);
  h.consumer.step({ name: "extract", run });
  const { attemptId } = seedAttempt(h.db);
  h.db.before = (sql) => {
    if (
      sql.startsWith("UPDATE cfordo_attempts SET output_json") ||
      sql.includes("SET status = 'failed'")
    )
      throw new Error("D1 unavailable");
  };
  const message = queueMessage(h.intent(attemptId));
  await h.consumer.queue(queueBatch([message]), {}, { waitUntil() {} });
  assert.equal(message.retried, true);
  assert.equal(h.hub.events.length, 0);
});

test("uncertain in-flight execution is not automatically rerun", async (t) => {
  const h = await harness(t);
  let runs = 0;
  h.consumer.step({
    name: "extract",
    run: async (ctx) => {
      runs++;
      await ctx.complete(null);
    },
  });
  const { attemptId } = seedAttempt(h.db);
  h.db.sqlite
    .prepare("UPDATE cfordo_attempts SET status='running' WHERE id=?")
    .run(attemptId);
  const message = queueMessage(h.intent(attemptId), 2);
  await h.consumer.queue(queueBatch([message]), {}, { waitUntil() {} });
  assert.equal(message.retried, true);
  assert.equal(runs, 0);
});

test("expired queued work is acknowledged without starting business logic", async (t) => {
  const h = await harness(t);
  let runs = 0;
  h.consumer.step({
    name: "extract",
    run: async (ctx) => {
      runs++;
      await ctx.complete(null);
    },
  });
  const { attemptId } = seedAttempt(h.db, { expiresAt: Date.now() - 1 });
  const message = queueMessage(h.intent(attemptId));
  await h.consumer.queue(queueBatch([message]), {}, { waitUntil() {} });
  assert.equal(runs, 0);
  assert.equal(message.acknowledged, true);
});

test("old or malformed message envelopes are not executed", async (t) => {
  const h = await harness(t);
  h.consumer.step({ name: "extract", run });
  const { attemptId } = seedAttempt(h.db);
  for (const body of [
    { protocol: "cfordo/1", attemptId },
    { protocol: "cfordo/2", attemptId: [] },
    { protocol: "cfordo/2", attemptId: -1 },
  ]) {
    const message = queueMessage(body);
    await h.consumer.queue(queueBatch([message]), {}, { waitUntil() {} });
    assert.equal(message.retried, true);
  }
  assert.equal(h.db.rows("cfordo_attempts")[0].status, "ready");
});

test("missing handlers are recorded as configuration failures, not dispatched to another step", async (t) => {
  const h = await harness(t);
  h.consumer.step({ name: "known", run });
  const { attemptId } = seedAttempt(h.db, { stepName: "missing" });
  const message = queueMessage(h.intent(attemptId));
  await h.consumer.queue(queueBatch([message]), {}, { waitUntil() {} });
  const row = h.db.rows("cfordo_attempts")[0];
  assert.equal(row.status, "failed");
  assert.equal(JSON.parse(row.error_json).fatal, true);
});
