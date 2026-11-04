import assert from "node:assert/strict";
import { test } from "node:test";
import { Ordo } from "./.build/core.mjs";
import { harness, queueBatch, seedAttempt, queueMessage } from "./fixtures.mjs";
const run = async (ctx) => {
  await ctx.complete(null);
};

test("invalid definitions and duplicate names are rejected before business execution", async (t) => {
  const h = await harness(t);
  for (const definition of [
    { name: "", run },
    { name: "missing" },
    { name: "old", run, worker: "x" },
    { name: "old", run, output: {} },
  ])
    assert.throws(() => h.workflow.step(definition));
  h.workflow.step({ name: "job", run });
  assert.throws(
    () => h.workflow.step({ name: "job", run }),
    /already registered/,
  );
  assert.equal(h.db.rows("cfordo_goals").length, 0);
});

test("parallel registration rejects empty/nested/synchronous groups and rolls back definitions", async (t) => {
  const h = await harness(t);
  let wrong = 0;
  await assert.rejects(
    h.workflow.parallel(async () => {}),
    /contain a Step/,
  );
  await assert.rejects(
    h.workflow.parallel(() => undefined),
    /asynchronous/,
  );
  await assert.rejects(
    h.workflow.parallel(async () => {
      h.workflow.step({
        name: "job",
        run: async (ctx) => {
          wrong++;
          await ctx.complete(null);
        },
      });
      await h.workflow.parallel(async () => {});
    }),
    /Nested/,
  );
  await h.workflow.parallel(async () => {
    h.workflow.step({ name: "job", run });
  });
  await h.run({});
  assert.equal(await h.status(), "completed");
  assert.equal(wrong, 0);
  assert.throws(() => h.workflow.step({ name: "after", run }), /cannot change/);
  assert.throws(
    () => h.workflow.configure({ expiresIn: 1000 }),
    /cannot change/,
  );
});

test("all three bindings and a nonempty playbook are required", async (t) => {
  const h = await harness(t);
  for (const key of ["DB", "QUEUE", "WORKFLOW"]) {
    const env = { ...h.env };
    delete env[key];
    const definition = new Ordo(env);
    definition.step({ name: "job", run });
    assert.throws(() => definition.ready(), /requires/);
  }
  assert.throws(() => h.workflow.ready(), /At least one/);
});

test("lifetime configuration and initial JSON are checked before creating a Goal", async (t) => {
  const h = await harness(t);
  for (const expiresIn of [0, -1, 1.5, Infinity, "1000"])
    assert.throws(() => h.workflow.configure({ expiresIn }), /positive/);
  h.workflow.step({ name: "job", run });
  await assert.rejects(h.run({ invalid: undefined }), /JSON/);
  assert.equal(h.db.rows("cfordo_goals").length, 0);
});

test("registration performs no I/O and execution migrates the database automatically", async (t) => {
  const h = await harness(t, { initialize: false });
  h.workflow.step({
    name: "job",
    run: async (ctx) => {
      assert.deepEqual(
        h.db.rows("cfordo_schema_versions").map((row) => row.id),
        [1],
      );
      await ctx.complete(ctx.input().params);
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
  await h.run({ value: 7 });
  assert.equal(await h.status(), "completed");
});

test("configure is optional and defaults to 24 hours", async (t) => {
  const h = await harness(t);
  const definition = new Ordo(h.env);
  definition.step({ name: "job", run });
  h.consumer.step({ name: "job", run });
  await h.replay(definition, {});
  const goal = await h.goal();
  assert.equal(goal.expiresAt - goal.createdAt, 86400000);
});

test("same saved function can be reused by two steps with its instance binding intact", async (t) => {
  const h = await harness(t);
  const owner = {
    factor: 3,
    async process(ctx) {
      await ctx.complete(ctx.input().params.value * this.factor);
    },
    async check(ctx) {
      assert.equal(ctx.input().result, 7 * this.factor);
      await ctx.ok();
    },
  };
  const definition = h.newDefinition(owner);
  definition.step({ name: "a", run: owner.process, validate: owner.check });
  definition.step({ name: "b", run: owner.process, evaluate: owner.check });
  h.consumer.step({
    name: "a",
    run: owner.process.bind(owner),
    validate: owner.check.bind(owner),
  });
  h.consumer.step({
    name: "b",
    run: owner.process.bind(owner),
    evaluate: owner.check.bind(owner),
  });
  await h.replay(definition, { value: 7 });
  assert.equal(await h.status(), "completed");
});

test("concurrent deliveries keep params and notification destinations separate", async (t) => {
  const h = await harness(t);
  const gate = Promise.withResolvers();
  let arrivals = 0;
  h.consumer.step({
    name: "extract",
    run: async (ctx) => {
      if (++arrivals === 2) gate.resolve();
      await gate.promise;
      await ctx.complete(ctx.input().params);
    },
  });
  const a = seedAttempt(h.db, { input: { tenant: "a" }, instanceId: "a" });
  const b = seedAttempt(h.db, { input: { tenant: "b" }, instanceId: "b" });
  await Promise.all(
    [a, b].map((item) =>
      h.consumer.queue(
        queueBatch([queueMessage(h.intent(item.attemptId))]),
        {},
        { waitUntil() {} },
      ),
    ),
  );
  assert.deepEqual(h.destinations.sort(), ["a", "b"]);
  assert.deepEqual(
    h.db.rows("cfordo_attempts").map((row) => JSON.parse(row.output_json)),
    [{ tenant: "a" }, { tenant: "b" }],
  );
});

test("initialization failure starts no business logic", async (t) => {
  const h = await harness(t, { initialize: false });
  let called = false;
  h.workflow.step({
    name: "job",
    run: async (ctx) => {
      called = true;
      await ctx.complete(null);
    },
  });
  h.db.before = (sql) => {
    if (sql.startsWith("CREATE TABLE cfordo_goals"))
      throw new Error("migration unavailable");
  };
  await assert.rejects(h.run({}), /migration unavailable/);
  await assert.rejects(
    h.consumer.queue(queueBatch([]), {}, { waitUntil() {} }),
    /migration unavailable/,
  );
  assert.equal(called, false);
});
