import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { basename } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { unstable_readConfig } from "wrangler";

async function startRuntime(t, configUrl, bindings = {}) {
  const root = fileURLToPath(new URL("../", import.meta.url));
  const configPath = fileURLToPath(configUrl);
  const config = unstable_readConfig({ config: configPath });
  const bundle = fileURLToPath(
    new URL(`../.wrangler/${config.name}-test-bundle`, import.meta.url),
  );
  execFileSync(
    process.execPath,
    [
      fileURLToPath(
        new URL("../node_modules/wrangler/bin/wrangler.js", import.meta.url),
      ),
      "deploy",
      "--dry-run",
      "--config",
      configPath,
      "--outdir",
      bundle,
    ],
    {
      cwd: root,
      env: { ...process.env, WRANGLER_SEND_METRICS: "false" },
      stdio: "pipe",
    },
  );

  const mf = new Miniflare(
    convertV4MiniflareOptions({
      name: config.name,
      compatibilityDate: config.compatibility_date,
      modules: true,
      bindings,
      scriptPath: `${bundle}/${basename(config.main).replace(/\.ts$/, ".js")}`,
      // Never use remote bindings when testing the deployable example.
      d1Databases: Object.fromEntries(
        config.d1_databases.map(({ binding }) => [
          binding,
          `${config.name}-${binding}-test`,
        ]),
      ),
      queueProducers: Object.fromEntries(
        config.queues.producers.map(({ binding, queue }) => [binding, queue]),
      ),
      queueConsumers: Object.fromEntries(
        config.queues.consumers.map(({ queue }) => [
          queue,
          { maxBatchTimeout: 0, retryDelay: 0 },
        ]),
      ),
      workflows: Object.fromEntries(
        config.workflows.map(({ binding, name, class_name }) => [
          binding,
          { name, className: class_name },
        ]),
      ),
    }),
  );
  t.after(() => mf.dispose());
  return mf;
}

async function json(mf, path, body) {
  return mf.dispatchFetch(
    `https://test${path}`,
    body === undefined
      ? undefined
      : {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        },
  );
}
async function startGoal(mf, input) {
  const response = await json(mf, "/_ordo/goals", input);
  assert.equal(response.status, 202, await response.clone().text());
  const { goalId } = await response.json();
  assert.equal(typeof goalId, "number");
  assert.equal(response.headers.get("Location"), `/_ordo/goals/${goalId}`);
  return goalId;
}
async function waitForGoal(mf, goalId) {
  const deadline = Date.now() + 15000;
  let result;
  while (Date.now() < deadline) {
    const response = await json(mf, `/_ordo/goals/${goalId}`);
    assert.equal(response.status, 200, await response.clone().text());
    result = await response.json();
    if (["completed", "failed", "expired"].includes(result.status))
      return result;
    await delay(25);
  }
  assert.fail(`Goal did not finish: ${JSON.stringify(result)}`);
}

test(
  "dedicated Worker HTTP API executes success, retry, parallel and failure paths",
  { timeout: 60000 },
  async (t) => {
    const mf = await startRuntime(
      t,
      new URL("wrangler.jsonc", import.meta.url),
    );
    const goals = [];
    for (const mode of ["success", "retry", "parallel", "parallel-fail"]) {
      const id = await startGoal(mf, { value: 7, mode });
      const goal = await waitForGoal(mf, id);
      goals.push(goal);
      assert.equal(
        goal.status,
        mode === "parallel-fail" ? "failed" : "completed",
        JSON.stringify(goal),
      );
      assert.deepEqual(goal.input, { value: 7, mode });
      assert.ok(goal.createdAt <= goal.finishedAt);
      if (mode !== "parallel-fail") {
        assert.ok(
          goal.results.every((result) => result.status === "completed"),
        );
        assert.equal(
          goal.results.find((result) => result.stepName === "extract").output
            .value,
          7,
        );
        assert.deepEqual(
          goal.results.find((result) => result.stepName === "finalize").output,
          { done: true },
        );
      }
    }
    const retry = goals[1].results.find(
      (result) => result.stepName === "extract",
    );
    assert.deepEqual(
      retry.executions.map((e) => e.action),
      ["run", "validate", "evaluate", "run", "validate", "evaluate"],
    );
    assert.deepEqual(retry.executions[2].verdict, {
      ok: false,
      reason: "try again",
    });
    assert.equal(retry.output.feedback, "try again");
    assert.deepEqual(retry.evaluation, { ok: true });
    const failed = goals[3].results.find(
      (result) => result.stepName === "extract",
    );
    assert.equal(failed.executions.length, 3);
    assert.equal(failed.error.message, "business failure");
    assert.equal(
      goals[3].results.find((r) => r.stepName === "finalize").executions.length,
      0,
    );
    const list = await (await json(mf, "/_ordo/goals")).json();
    assert.equal(list.length, 4);
    assert.deepEqual(
      list.map((goal) => goal.goalId),
      goals.map((goal) => goal.goalId).reverse(),
    );
    assert.ok(
      list.every((goal) =>
        goal.results.every(
          (result) => !("executions" in result) && !("attempts" in result),
        ),
      ),
    );
  },
);

test(
  "deployed example entrypoint supports concurrent independent Goals and execution history",
  { timeout: 30000 },
  async (t) => {
    const mf = await startRuntime(
      t,
      new URL("../example/wrangler.jsonc", import.meta.url),
    );
    assert.deepEqual(await (await json(mf, "/_ordo/goals")).json(), []);
    const inputs = [7, 11, 23];
    const ids = await Promise.all(
      inputs.map((value) => startGoal(mf, { value })),
    );
    assert.equal(new Set(ids).size, inputs.length);
    const goals = await Promise.all(ids.map((id) => waitForGoal(mf, id)));
    for (let i = 0; i < inputs.length; i++) {
      const goal = goals[i];
      assert.equal(goal.status, "completed", JSON.stringify(goal));
      assert.equal(goal.input.value, inputs[i]);
      assert.deepEqual(
        goal.results.map((result) => result.output),
        [{ value: inputs[i] * 2 }, { value: inputs[i] ** 2 }],
      );
      for (const result of goal.results) {
        assert.equal(result.status, "completed");
        assert.equal(result.action, null);
        assert.deepEqual(result.validation, { ok: true });
        assert.deepEqual(result.evaluation, { ok: true });
        assert.deepEqual(
          result.executions.map((e) => e.action),
          ["run", "validate", "evaluate"],
        );
        assert.ok(
          result.executions.every(
            (e) => e.status === "completed" && e.error === null,
          ),
        );
        const runId = result.executions[0].attemptId;
        assert.deepEqual(
          result.executions.map((e) => e.sourceRunId),
          [null, runId, runId],
        );
      }
    }
    const db = await mf.getD1Database("DB");
    assert.equal(
      (await db.prepare("SELECT count(*) AS n FROM cfordo_goals").first()).n,
      3,
    );
    assert.equal(
      (await db.prepare("SELECT count(*) AS n FROM cfordo_attempts").first()).n,
      18,
    );
    const versions = await db
      .prepare("SELECT id FROM cfordo_schema_versions")
      .all();
    assert.deepEqual(
      versions.results.map((row) => row.id),
      [1],
    );
    assert.equal((await json(mf, "/_ordo/goals/9999")).status, 404);
    assert.equal((await json(mf, "/_ordo/goals/nope")).status, 400);
  },
);

test(
  "expiration includes the delay between HTTP acceptance and Workflow start",
  { timeout: 30000 },
  async (t) => {
    const mf = await startRuntime(
      t,
      new URL("wrangler.jsonc", import.meta.url),
      { EXPIRES_IN: "1" },
    );
    const id = await startGoal(mf, { value: 7 });
    const goal = await waitForGoal(mf, id);
    assert.equal(goal.status, "expired");
    assert.equal(goal.finishedAt, null);
    assert.equal(goal.expiresAt - goal.createdAt, 1);
  },
);

test(
  "setup failures are rejected before Goal creation or business execution",
  { timeout: 30000 },
  async (t) => {
    const mf = await startRuntime(
      t,
      new URL("wrangler.jsonc", import.meta.url),
      { FAIL_SETUP: "1" },
    );
    const response = await json(mf, "/_ordo/goals", { value: 7 });
    assert.equal(response.status, 500);
    assert.equal((await response.json()).error.code, "InternalError");
    const db = await mf.getD1Database("DB");
    const table = await db
      .prepare("SELECT name FROM sqlite_master WHERE name='cfordo_goals'")
      .first();
    assert.equal(table, null);
  },
);
