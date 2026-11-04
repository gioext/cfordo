import assert from "node:assert/strict";
import { test } from "node:test";
import { harness } from "../fixtures.mjs";

const run = async (ctx) => {
  await ctx.complete(ctx.input().params);
};
const ok = async (ctx) => {
  await ctx.ok();
};

test("run, validate and evaluate are separate queued executions with D1 inputs and void returns", async (t) => {
  const h = await harness(t);
  const seen = [];
  h.workflow.step({
    name: "calculate",
    run: async (ctx) => {
      seen.push(["run", ctx.input()]);
      await ctx.complete({ value: ctx.input().params.value * 2 });
      return { poison: "ignored" };
    },
    validate: async (ctx) => {
      seen.push(["validate", ctx.input()]);
      await ctx.ok();
      return { ok: false };
    },
    evaluate: async (ctx) => {
      seen.push(["evaluate", ctx.input()]);
      await ctx.ok();
      return { ok: false };
    },
  });
  assert.equal(await h.run({ value: 7 }), undefined);
  assert.equal(await h.status(), "completed");
  assert.deepEqual(seen, [
    ["run", { params: { value: 7 }, result: undefined }],
    ["validate", { params: { value: 7 }, result: { value: 14 } }],
    ["evaluate", { params: { value: 7 }, result: { value: 14 } }],
  ]);
  const rows = h.db.rows("cfordo_attempts");
  assert.deepEqual(
    rows.map((r) => r.action),
    ["run", "validate", "evaluate"],
  );
  assert.equal(h.sent.length, 3);
  assert.ok(
    h.sent.every(
      (body) => Object.keys(body).sort().join(",") === "attemptId,protocol",
    ),
  );
  assert.ok(rows.every((r) => r.status === "completed"));
  assert.equal(rows[1].source_run_id, rows[0].id);
  assert.equal(rows[2].source_run_id, rows[0].id);
  for (const call of h.step.calls.filter((call) => call.config))
    assert.equal(await h.step.cache.get(call.name), undefined);
  assert.ok(h.hub.events.every((event) => event.payload === null));
});

for (const source of ["run", "validate", "evaluate"]) {
  test(`${source} exceptions retry only that action and share the three-exception budget`, async (t) => {
    const h = await harness(t);
    const calls = { run: 0, validate: 0, evaluate: 0 };
    h.workflow.step({
      name: "job",
      run: async (ctx) => {
        if (++calls.run < 3 && source === "run") throw new Error("transient");
        await ctx.complete({ value: 7 });
      },
      validate: async (ctx) => {
        if (++calls.validate < 3 && source === "validate")
          throw new Error("transient");
        assert.equal(ctx.input().result.value, 7);
        await ctx.ok();
      },
      evaluate: async (ctx) => {
        if (++calls.evaluate < 3 && source === "evaluate")
          throw new Error("transient");
        assert.equal(ctx.input().result.value, 7);
        await ctx.ok();
      },
    });
    await h.run({});
    assert.equal(await h.status(), "completed");
    assert.deepEqual(calls, {
      run: source === "run" ? 3 : 1,
      validate: source === "validate" ? 3 : 1,
      evaluate: source === "evaluate" ? 3 : 1,
    });
    assert.equal(
      h.db.rows("cfordo_attempts").filter((r) => r.status === "failed").length,
      2,
    );
  });
}
for (const [source, maximum] of [
  ["validate", 3],
  ["evaluate", 10],
]) {
  test(`${source} NG restarts run with feedback and stops at the fixed limit`, async (t) => {
    const h = await harness(t);
    const feedback = [];
    h.workflow.step({
      name: "job",
      run: async (ctx) => {
        feedback.push(ctx.feedback);
        await ctx.complete({ value: 7 });
      },
      validate: async (ctx) => {
        if (source === "validate") await ctx.ng("try again");
        else await ctx.ok();
      },
      evaluate: async (ctx) => {
        if (source === "evaluate") await ctx.ng("try again");
        else await ctx.ok();
      },
    });
    h.workflow.step({ name: "never", run });
    await h.run({});
    assert.equal(await h.status(), "failed");
    assert.equal(feedback.length, maximum);
    assert.equal(feedback[0], undefined);
    assert.deepEqual(feedback[1], { source, reason: "try again" });
    const rows = h.db.rows("cfordo_attempts");
    assert.ok(
      rows.every((r) => r.step_name === "job" && r.status === "completed"),
    );
    assert.equal(rows.filter((r) => r.action === source).length, maximum);
    if (source === "validate")
      assert.equal(rows.filter((r) => r.action === "evaluate").length, 0);
  });
}

test("exception counts do not reset after a later NG reruns business logic", async (t) => {
  const h = await harness(t);
  let runs = 0,
    validations = 0;
  h.workflow.step({
    name: "job",
    run: async (ctx) => {
      runs++;
      await ctx.complete({});
    },
    validate: async (ctx) => {
      validations++;
      if ([1, 2, 4].includes(validations)) throw new Error("check failed");
      await ctx.ok();
    },
    evaluate: async (ctx) => {
      await ctx.ng("retry run");
    },
  });
  await h.run({});
  assert.equal(await h.status(), "failed");
  assert.equal(runs, 2);
  assert.equal(validations, 4);
});

test("parallel stages overlap, successful siblings are not rerun, and the final step waits for both", async (t) => {
  const h = await harness(t);
  const gate = Promise.withResolvers();
  let runsA = 0,
    runsB = 0;
  const order = [];
  await h.workflow.parallel(async () => {
    h.workflow.step({
      name: "a",
      run: async (ctx) => {
        order.push("a");
        runsA++;
        await gate.promise;
        await ctx.complete(runsA);
      },
      validate: async (ctx) => {
        if (ctx.input().result < 3) await ctx.ng("again");
        else await ctx.ok();
      },
    });
    h.workflow.step({
      name: "b",
      run: async (ctx) => {
        order.push("b");
        runsB++;
        gate.resolve();
        await ctx.complete(null);
      },
    });
  });
  h.workflow.step({
    name: "last",
    run: async (ctx) => {
      order.push("last");
      assert.equal(
        h.db
          .rows("cfordo_attempts", "step_name='a' AND action='validate'")
          .at(-1).status,
        "completed",
      );
      await ctx.complete(null);
    },
  });
  await h.run({});
  assert.equal(await h.status(), "completed");
  assert.equal(runsA, 3);
  assert.equal(runsB, 1);
  assert.equal(order.at(-1), "last");
  assert.ok(order.includes("b"));
});

for (const checks of [[], ["validate"], ["evaluate"]]) {
  test(`omitted checks are skipped (${checks.join(",") || "run only"})`, async (t) => {
    const h = await harness(t);
    h.workflow.step({
      name: "job",
      run,
      ...Object.fromEntries(checks.map((name) => [name, ok])),
    });
    await h.run({});
    assert.equal(await h.status(), "completed");
    assert.deepEqual(
      h.db.rows("cfordo_attempts").map((r) => r.action),
      ["run", ...checks],
    );
  });
}

test("replay uses Workflow identity and D1, even without cached return values", async (t) => {
  const h = await harness(t);
  let runs = 0;
  const definition = {
    name: "job",
    run: async (ctx) => {
      runs++;
      await ctx.complete(null);
    },
    validate: ok,
    evaluate: ok,
  };
  h.workflow.step(definition);
  await h.run({ value: 7 });
  const replay = h.newDefinition();
  replay.step(definition);
  h.step.cache.clear();
  await h.replay(replay, { value: 999 });
  assert.equal(runs, 1);
  assert.equal(h.db.rows("cfordo_goals").length, 1);
  assert.deepEqual((await h.goal()).input, { value: 7 });
  assert.equal(h.db.rows("cfordo_attempts").length, 3);
});

test("late run results are retained but do not start validation after expiration", async (t) => {
  const original = Date.now;
  let now = original();
  Date.now = () => now;
  t.after(() => {
    Date.now = original;
  });
  const h = await harness(t, { expiresIn: 100 });
  let checked = false;
  h.workflow.step({
    name: "job",
    run: async (ctx) => {
      now += 100;
      await ctx.complete({ late: true });
    },
    validate: async (ctx) => {
      checked = true;
      await ctx.ok();
    },
  });
  await h.run({});
  assert.equal(await h.status(), "expired");
  assert.equal(checked, false);
  assert.equal(h.db.rows("cfordo_attempts").length, 1);
  assert.equal(h.db.rows("cfordo_attempts")[0].status, "completed");
});

test("dispatch failures are recorded and stop at the common exception limit", async (t) => {
  const h = await harness(t);
  h.runtime.failDispatch = 10;
  h.workflow.step({ name: "job", run });
  await h.run({});
  assert.equal(await h.status(), "failed");
  assert.equal(h.db.rows("cfordo_attempts").length, 3);
});

test("an expired replay stops without re-entering a cached wait", async (t) => {
  const original = Date.now;
  let now = original();
  Date.now = () => now;
  t.after(() => {
    Date.now = original;
  });
  const h = await harness(t, { expiresIn: 100 });
  h.runtime.dropDelivery = true;
  h.workflow.step({ name: "job", run });
  const waiting = h.run({});
  while (!h.step.calls.some((c) => c.options)) await Promise.resolve();
  now += 100;
  const replay = h.newDefinition();
  replay.step({ name: "job", run });
  await h.replay(replay, {});
  assert.equal(await h.status(), "expired");
  await h.hub.send({
    type: `ordo-completed-${h.sent[0].attemptId}`,
    payload: null,
  });
  await waiting;
});

test(
  "a resumed in-flight Workflow reads D1 and reuses execution IDs without return-value state",
  { timeout: 3000 },
  async (t) => {
    const h = await harness(t);
    h.runtime.dropDelivery = true;
    const calls = { run: 0, validate: 0, evaluate: 0 };
    const definition = {
      name: "job",
      run: async (ctx) => {
        calls.run++;
        await ctx.complete({ value: 7 });
      },
      validate: async (ctx) => {
        calls.validate++;
        assert.equal(ctx.input().result.value, 7);
        await ctx.ok();
      },
      evaluate: async (ctx) => {
        calls.evaluate++;
        await ctx.ok();
      },
    };
    h.workflow.step(definition);
    const original = h.run({});
    while (!h.step.calls.some((call) => call.options)) await Promise.resolve();
    const replay = h.newDefinition();
    replay.step(definition);
    const resumed = h.replay(replay, {});
    h.runtime.dropDelivery = false;
    const { queueBatch, queueMessage } = await import("../fixtures.mjs");
    await h.consumer.queue(
      queueBatch([queueMessage(h.sent[0])]),
      {},
      { waitUntil() {} },
    );
    await Promise.all([original, resumed]);
    await h.drain();
    assert.equal(await h.status(), "completed");
    assert.deepEqual(calls, { run: 1, validate: 1, evaluate: 1 });
    assert.equal(h.sent.length, 3);
    assert.equal(h.db.rows("cfordo_goals").length, 1);
    assert.equal(h.db.rows("cfordo_attempts").length, 3);
  },
);
