import assert from "node:assert/strict";
import { test } from "node:test";
import { Ordo } from "./.build/core.mjs";
import { harness, queueBatch, queueMessage, seedAttempt } from "./fixtures.mjs";

const run = async () => null;

test("registration rejects invalid definitions without launching a Goal", async (t) => {
  const h = await harness(t);
  assert.throws(() => h.workflow.step({ name: "", run }));
  for (const key of ["success", "failure", "next", "output", "worker"]) {
    assert.throws(() => h.workflow.step({ name: "x", run, [key]: "y" }));
  }
  h.workflow.step({ name: "x", run });
  assert.throws(
    () => h.workflow.step({ name: "x", run }),
    /already registered/,
  );
  assert.throws(() => h.workflow.step({ name: "missing" }), /run function/);
  assert.equal(h.db.rows("cfordo_goals").length, 0);
  assert.equal(h.db.rows("cfordo_attempts").length, 0);
});

test("parallel registration is async, rejects nesting and rolls back steps and executors", async (t) => {
  const h = await harness(t);
  await assert.rejects(
    h.workflow.parallel(async () => {}),
    /contain a Step/,
  );
  await assert.rejects(
    h.workflow.parallel(() => undefined),
    /asynchronous/,
  );
  let rolledBackRuns = 0;
  await assert.rejects(
    h.workflow.parallel(async () => {
      h.workflow.step({
        name: "reusable",
        run: async () => {
          rolledBackRuns++;
          return null;
        },
      });
      await h.workflow.parallel(async () => {});
    }),
    /Nested/,
  );
  await h.workflow.parallel(async () => {
    await Promise.resolve();
    h.workflow.step({ name: "reusable", run });
  });
  assert.equal(await h.run({}), "completed");
  assert.equal(rolledBackRuns, 0);
  assert.throws(() => h.workflow.step({ name: "after", run }), /cannot change/);
  assert.throws(
    () => h.workflow.configure({ expiresIn: 1000 }),
    /cannot change/,
  );
  assert.throws(
    () => h.workflow.binding(h.configuration.bindings),
    /cannot change/,
  );
});

test("binding is mandatory and all three resources are checked before execution", async (t) => {
  const h = await harness(t);
  const definition = new Ordo();
  definition.step({ name: "x", run });
  assert.throws(() => definition.ready(), /must call binding/);
  for (const key of ["db", "queue", "workflow"]) {
    const bindings = { ...h.configuration.bindings };
    delete bindings[key];
    assert.throws(
      () => definition.binding(bindings),
      /requires db, queue and workflow/,
    );
  }
  definition.binding(h.configuration.bindings);
  assert.throws(
    () => definition.binding(h.configuration.bindings),
    /already been configured/,
  );
  definition.ready();
  assert.equal(h.db.rows("cfordo_goals").length, 0);
});

test("configuration validates lifetime and no Steps or invalid JSON cannot launch a Goal", async (t) => {
  const h = await harness(t);
  for (const expiresIn of [0, -1, 1.5, Infinity, "1000"]) {
    assert.throws(() => h.workflow.configure({ expiresIn }), /positive number/);
  }
  assert.equal(await h.run({}), "failed");
  h.workflow.step({ name: "x", run });
  assert.equal(await h.run({ invalid: undefined }), "failed");
  assert.equal(h.db.rows("cfordo_goals").length, 0);
});

test(
  "binding and registration perform no I/O; execution initializes the database",
  { timeout: 3000 },
  async (t) => {
    const h = await harness(t, { initialize: false });
    h.workflow.step({
      name: "extract",
      run: async (ctx) => {
        assert.deepEqual(
          h.db.rows("cfordo_schema_versions").map((row) => row.id),
          [1],
        );
        return ctx.params();
      },
    });
    assert.equal(
      h.db.sqlite
        .prepare(
          "SELECT count(*) AS n FROM sqlite_master WHERE name LIKE 'cfordo_%'",
        )
        .get().n,
      0,
    );
    assert.equal(await h.run({ value: 7 }), "completed");
    assert.equal(h.db.rows("cfordo_goals")[0].status, "completed");
  },
);

test("omitted configure uses a 24-hour lifetime", async (t) => {
  const h = await harness(t);
  const definition = new Ordo();
  definition.binding(h.configuration.bindings);
  definition.step({ name: "extract", run });
  h.consumer.step({ name: "extract", run });
  assert.equal(await h.replay(definition, {}), "completed");
  const goal = h.db.rows("cfordo_goals")[0];
  assert.equal(goal.expires_at - goal.created_at, 86400000);
});

test("concurrent deliveries use their own context and configured notification destination", async (t) => {
  const h = await harness(t);
  const gate = Promise.withResolvers();
  let arrivals = 0;
  h.consumer.step({
    name: "extract",
    run: async (ctx) => {
      if (++arrivals === 2) gate.resolve();
      await gate.promise;
      return ctx.params();
    },
  });
  const first = seedAttempt(h.db, { input: { tenant: "a" } });
  const second = seedAttempt(h.db, { input: { tenant: "b" } });
  const messageA = queueMessage(h.intent(first.attemptId, { instanceId: "a" }));
  const messageB = queueMessage(
    h.intent(second.attemptId, { instanceId: "b" }),
  );
  const handler = { queue: h.consumer.queue };
  await Promise.all([
    handler.queue(queueBatch([messageA]), {}, { waitUntil() {} }),
    handler.queue(queueBatch([messageB]), {}, { waitUntil() {} }),
  ]);
  assert.equal(messageA.acknowledged, true);
  assert.equal(messageB.acknowledged, true);
  assert.deepEqual(
    h.db.rows("cfordo_attempts").map((row) => JSON.parse(row.output_json)),
    [{ tenant: "a" }, { tenant: "b" }],
  );
  assert.equal(h.hub.events.length, 2);
  assert.deepEqual(h.destinations.sort(), ["a", "b"]);
});

test("initialization failure prevents run and queue from invoking business work", async (t) => {
  const h = await harness(t, { initialize: false });
  let runs = 0;
  h.db.before = (sql) => {
    if (sql.startsWith("CREATE TABLE cfordo_goals"))
      throw new Error("migration unavailable");
  };
  h.workflow.step({
    name: "extract",
    run: async () => {
      runs++;
      return {};
    },
  });
  assert.equal(await h.run({}), "failed");
  const message = queueMessage({
    protocol: "cfordo/1",
    goalId: 1,
    attemptId: 1,
    stepName: "extract",
    instanceId: "workflow-1",
  });
  await assert.rejects(
    h.consumer.queue(queueBatch([message]), {}, { waitUntil() {} }),
    /migration unavailable/,
  );
  assert.equal(runs, 0);
  assert.equal(h.hub.events.length, 0);
});
