import assert from "node:assert/strict";
import { test } from "node:test";
import { createContext } from "./.build/core.mjs";
import { claimAttempt, finishAttempt, getAttempt } from "../src/db/store.ts";
import { harness, seedAttempt } from "./fixtures.mjs";

test("complete overwrites the same active record and does not finalize execution itself", async (t) => {
  const h = await harness(t);
  const { attemptId } = seedAttempt(h.db);
  await claimAttempt(h.db, attemptId);
  const ctx = createContext(
    h.db,
    await getAttempt(h.db, attemptId),
    { items: [1] },
    undefined,
  );
  ctx.input().params.items.push(2);
  assert.deepEqual(ctx.input(), { params: { items: [1] }, result: undefined });
  assert.equal(await ctx.complete({ value: 1 }), undefined);
  await ctx.complete({ value: 2 });
  let saved = await getAttempt(h.db, attemptId);
  assert.deepEqual(saved.output, { value: 2 });
  assert.equal(saved.status, "running");
  await finishAttempt(h.db, attemptId);
  await assert.rejects(ctx.complete({ value: 3 }), /not running/);
  assert.deepEqual((await getAttempt(h.db, attemptId)).output, { value: 2 });
});

test("ok and ng persist fixed verdicts and may overwrite before finalization", async (t) => {
  const h = await harness(t);
  const { attemptId } = seedAttempt(h.db, { action: "validate" });
  await claimAttempt(h.db, attemptId);
  const ctx = createContext(h.db, await getAttempt(h.db, attemptId), {}, 7);
  await ctx.ng("first");
  await ctx.ok();
  await ctx.ng("final");
  assert.deepEqual((await getAttempt(h.db, attemptId)).validation, {
    ok: false,
    reason: "final",
  });
  assert.equal((await getAttempt(h.db, attemptId)).status, "running");
  for (const reason of [undefined, null, "", "  ", 1])
    await assert.rejects(ctx.ng(reason), /non-empty/);
  await assert.rejects(ctx.ok(7), /does not accept/);
  await assert.rejects(ctx.complete(7), /only available to run/);
});

test("run cannot save a verdict and only JSON-compatible business data can be persisted", async (t) => {
  const h = await harness(t);
  const { attemptId } = seedAttempt(h.db);
  await claimAttempt(h.db, attemptId);
  const ctx = createContext(
    h.db,
    await getAttempt(h.db, attemptId),
    {},
    undefined,
  );
  await assert.rejects(ctx.ok(), /only available to checks/);
  await assert.rejects(ctx.ng("reason"), /only available to checks/);
  const circular = {};
  circular.self = circular;
  for (const value of [undefined, NaN, new Date(), circular])
    await assert.rejects(ctx.complete(value));
  await ctx.complete(null);
  assert.equal((await getAttempt(h.db, attemptId)).output, null);
});

for (const action of ["run", "validate", "evaluate"]) {
  test(`a missing ${action} save fails through the common exception path`, async (t) => {
    const h = await harness(t);
    h.workflow.step({
      name: "job",
      run: async (ctx) => {
        if (action !== "run") await ctx.complete({});
      },
      validate: async (ctx) => {
        if (action !== "validate") await ctx.ok();
      },
      evaluate: async (ctx) => {
        if (action !== "evaluate") await ctx.ok();
      },
    });
    await h.run({});
    assert.equal(await h.status(), "failed");
    const failures = h.db
      .rows("cfordo_attempts")
      .filter((r) => r.status === "failed");
    assert.equal(failures.length, 3);
    assert.ok(
      failures.every(
        (r) =>
          r.action === action &&
          JSON.parse(r.error_json).message.includes("without a saved"),
      ),
    );
  });
}

test("a save followed by an exception is failed, not published as completed", async (t) => {
  const h = await harness(t);
  let validations = 0;
  h.workflow.step({
    name: "job",
    run: async (ctx) => {
      await ctx.complete({ value: 1 });
      throw new Error("after save");
    },
    validate: async (ctx) => {
      validations++;
      await ctx.ok();
    },
  });
  await h.run({});
  assert.equal(await h.status(), "failed");
  assert.equal(validations, 0);
  assert.ok(
    h.db
      .rows("cfordo_attempts")
      .every((r) => r.output_json === '{"value":1}' && r.status === "failed"),
  );
});
