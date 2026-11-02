import assert from "node:assert/strict";
import { test } from "node:test";
import { createContext, runCheck } from "./.build/core.mjs";
import { harness } from "./fixtures.mjs";

const details = { goalId: 1, stepName: "test", attemptId: 1 };

test("context accessors preserve JSON values and isolate callback mutations", () => {
  const ctx = createContext(details, { list: [1] }, null);
  ctx.params().list.push(2);
  assert.deepEqual(ctx.params(), { list: [1] });
  assert.equal(ctx.result(), null);
  assert.equal(createContext(details, false).params(), false);
  assert.equal(createContext(details, {}).result(), undefined);
});

test("checks accept only decisions created by their own context", async () => {
  const ctx = createContext(details, {});
  assert.deepEqual(await runCheck(async (ctx) => ctx.ok(), ctx), { ok: true });
  assert.deepEqual(await runCheck(async (ctx) => ctx.ng("try again"), ctx), {
    ok: false,
    reason: "try again",
  });
  const other = createContext(details, {});
  for (const result of [
    undefined,
    null,
    true,
    { ok: true },
    { ok: false, reason: "bad" },
    other.ok(),
    { ...ctx.ok() },
  ]) {
    await assert.rejects(
      runCheck(async () => result, ctx),
      /must return/,
    );
  }
  for (const reason of [undefined, null, "", "  ", 1])
    assert.throws(() => ctx.ng(reason), /non-empty/);
  assert.throws(() => ctx.ok({ value: 1 }), /does not accept/);
  assert.throws(() => ctx.ng("reason", "extra"), /non-empty/);
});

test("invalid check returns use the exception budget rather than an NG retry", async (t) => {
  const h = await harness(t);
  let runs = 0,
    checks = 0;
  const step_job = {
    name: "job",
    run: async () => ({ count: ++runs }),
    validate: async () => {
      checks++;
      return { ok: true };
    },
  };
  h.workflow.step({ ...step_job, name: "job" });
  assert.equal(await h.run({}), "failed");
  assert.deepEqual([runs, checks], [1, 3]);
  assert.ok(
    h.db
      .rows("cfordo_attempts")
      .every((row) => JSON.parse(row.error_json).source === "validate"),
  );
});

test("business returns must be serializable, not decisions or missing values", async (t) => {
  for (const run of [
    async (ctx) => ctx.ok(),
    async () => undefined,
    async () => NaN,
    async () => new Date(),
    async () => {
      const value = {};
      value.self = value;
      return value;
    },
  ]) {
    const h = await harness(t);
    const step_job = { name: "job", run };
    h.workflow.step({ ...step_job, name: "job" });
    assert.equal(await h.run({}), "failed");
    assert.equal(h.db.rows("cfordo_attempts").length, 3);
  }
});
