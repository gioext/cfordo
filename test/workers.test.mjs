import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { basename } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { unstable_readConfig } from "wrangler";

async function startRuntime(t, configUrl) {
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

async function waitForResult(status) {
  const deadline = Date.now() + 12000;
  let result;
  while (Date.now() < deadline) {
    result = await status();
    if (["complete", "errored", "terminated"].includes(result.status))
      return result;
    await delay(25);
  }
  return result;
}

test(
  "packaged ESM runs with real Workflows, Queues and D1",
  { timeout: 60000 },
  async (t) => {
    const mf = await startRuntime(
      t,
      new URL("wrangler.jsonc", import.meta.url),
    );
    for (const mode of [
      "success",
      "retry",
      "parallel",
      "expired",
      "parallel-fail",
    ]) {
      const response = await mf.dispatchFetch("https://test/start", {
        method: "POST",
        body: JSON.stringify({ value: 7, mode }),
      });
      assert.equal(response.status, 200);
      const { id } = await response.json();
      const status = await waitForResult(async () =>
        (
          await mf.dispatchFetch(`https://test/status?id=${id}&mode=${mode}`)
        ).json(),
      );
      assert.equal(
        status.status,
        "complete",
        `${mode}: ${JSON.stringify(status)}`,
      );
      assert.equal(
        status.output,
        mode === "expired"
          ? "expired"
          : mode === "parallel-fail"
            ? "failed"
            : "completed",
        `${mode}: ${JSON.stringify(status)}`,
      );
    }
    const db = await mf.getD1Database("DB");
    const goals = await db
      .prepare("SELECT * FROM cfordo_goals ORDER BY id")
      .all();
    assert.equal(goals.results.length, 5);
    assert.ok(["ready", "running"].includes(goals.results[3].status));
    const retries = await db
      .prepare(
        "SELECT * FROM cfordo_attempts WHERE goal_id=? AND step_name='extract' ORDER BY id",
      )
      .bind(goals.results[1].id)
      .all();
    assert.equal(retries.results.length, 2);
    assert.equal(retries.results[0].status, "failed");
    assert.equal(retries.results[1].status, "completed");
    assert.equal(
      JSON.parse(retries.results[1].output_json).feedback,
      "try again",
    );
    assert.equal(goals.results[4].status, "failed");
    const failedGoalAttempts = await db
      .prepare("SELECT step_name FROM cfordo_attempts WHERE goal_id=?")
      .bind(goals.results[4].id)
      .all();
    assert.ok(
      failedGoalAttempts.results.every((row) => row.step_name !== "finalize"),
    );
  },
);

test(
  "minimal example executes both parallel Queue workers",
  { timeout: 30000 },
  async (t) => {
    const mf = await startRuntime(
      t,
      new URL("../example/wrangler.jsonc", import.meta.url),
    );
    const db = await mf.getD1Database("DB");
    const { WORKFLOW } = await mf.getBindings();
    const instance = await WORKFLOW.create({ params: { value: 7 } });
    const status = await waitForResult(() => instance.status());
    assert.equal(status.status, "complete", JSON.stringify(status));
    assert.equal(status.output, "completed");
    const versions = await db
      .prepare("SELECT id FROM cfordo_schema_versions")
      .all();
    assert.deepEqual(
      versions.results.map((row) => row.id),
      [1],
    );
    const attempts = await db
      .prepare(
        "SELECT step_name,status,output_json FROM cfordo_attempts ORDER BY step_name",
      )
      .all();
    assert.deepEqual(
      attempts.results.map((row) => ({
        step: row.step_name,
        status: row.status,
        value: JSON.parse(row.output_json).value,
      })),
      [
        { step: "double", status: "completed", value: 14 },
        { step: "square", status: "completed", value: 49 },
      ],
    );
  },
);

test(
  "one Ordo publishes Workflow and default Queue entrypoints",
  { timeout: 30000 },
  async (t) => {
    const mf = await startRuntime(
      t,
      new URL("combined.wrangler.jsonc", import.meta.url),
    );
    const { WORKFLOW } = await mf.getBindings();
    const instances = await Promise.all(
      [11, 23].map((value) => WORKFLOW.create({ params: { value } })),
    );
    const statuses = await Promise.all(
      instances.map((instance) => waitForResult(() => instance.status())),
    );
    assert.deepEqual(
      statuses.map((status) => status.output),
      ["completed", "completed"],
    );
    const db = await mf.getD1Database("DB");
    const results = await db
      .prepare(
        "SELECT g.input_json, a.output_json FROM cfordo_goals g JOIN cfordo_attempts a ON a.goal_id=g.id WHERE a.step_name='extract'",
      )
      .all();
    assert.equal(results.results.length, 2);
    assert.deepEqual(
      results.results
        .map((row) => JSON.parse(row.input_json).value)
        .sort((a, b) => a - b),
      [11, 23],
    );
    for (const row of results.results)
      assert.equal(
        JSON.parse(row.input_json).value,
        JSON.parse(row.output_json).value,
      );
  },
);

test(
  "Queue factories are lazy, setup runs once per instance, and configuration errors fail before processing",
  { timeout: 30000 },
  async (t) => {
    const mf = await startRuntime(
      t,
      new URL("wrangler.jsonc", import.meta.url),
    );
    const response = await mf.dispatchFetch("https://test/lifecycle");
    assert.equal(response.status, 200);
    const result = await response.json();
    assert.deepEqual(result.rejected, ["rejected", "rejected"]);
    assert.equal(result.beforeReceiving, 0);
    assert.equal(result.sharedSetup, 1);
    assert.equal(result.separateInstances, 3);
    assert.equal(result.failures, 1);
    assert.match(result.missingBinding, /must call binding/);
    const db = await mf.getD1Database("DB");
    assert.equal(
      (await db.prepare("SELECT count(*) AS n FROM cfordo_attempts").first()).n,
      0,
    );
  },
);
