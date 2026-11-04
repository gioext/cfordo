import { DatabaseSync } from "node:sqlite";
import { initOrdo, Ordo } from "./.build/core.mjs";
import { getGoal } from "../src/db/store.ts";
import { getGoalStatus } from "./.build/core.mjs";

export class TestDatabase {
  constructor() {
    this.sqlite = new DatabaseSync(":memory:");
    this.sqlite.exec("PRAGMA foreign_keys = ON");
    this.before = undefined;
    this.after = undefined;
  }
  prepare(sql) {
    const db = this;
    function statement(values = []) {
      const execute = (kind) => {
        db.before?.(sql, values, kind);
        const prepared = db.sqlite.prepare(sql);
        let value;
        if (kind === "first") value = prepared.get(...values) ?? null;
        else if (kind === "all")
          value = { success: true, results: prepared.all(...values), meta: {} };
        else {
          const result = prepared.run(...values);
          value = {
            success: true,
            results: [],
            meta: {
              changes: Number(result.changes),
              last_row_id: Number(result.lastInsertRowid),
            },
          };
        }
        db.after?.(sql, values, kind);
        return value;
      };
      return {
        bind: (...bound) => statement(bound),
        first: async (column) => {
          const row = execute("first");
          return column === undefined || row === null ? row : row[column];
        },
        all: async () => execute("all"),
        run: async () => execute("run"),
        execute,
      };
    }
    return statement();
  }
  async batch(statements) {
    this.sqlite.exec("BEGIN");
    try {
      const result = statements.map((statement) => statement.execute("run"));
      this.sqlite.exec("COMMIT");
      return result;
    } catch (error) {
      this.sqlite.exec("ROLLBACK");
      throw error;
    }
  }
  rows(table, where = "1", ...values) {
    return this.sqlite
      .prepare(`SELECT * FROM ${table} WHERE ${where} ORDER BY id`)
      .all(...values)
      .map((row) => ({ ...row }));
  }
  close() {
    this.sqlite.close();
  }
}

export class EventHub {
  buffers = new Map();
  listeners = new Map();
  events = [];
  duplicate = false;
  failBefore = 0;
  failAfter = 0;
  async send(event) {
    if (this.failBefore-- > 0)
      throw new Error("Notification transport unavailable");
    for (let count = 0; count < (this.duplicate ? 2 : 1); count++) {
      this.events.push(structuredClone(event));
      const listener = this.listeners.get(event.type)?.shift();
      if (listener) listener({ payload: structuredClone(event.payload) });
      else
        this.buffers.set(event.type, [
          ...(this.buffers.get(event.type) ?? []),
          structuredClone(event.payload),
        ]);
    }
    if (this.failAfter-- > 0) throw new Error("Notification response lost");
  }
  wait(type) {
    const buffer = this.buffers.get(type);
    if (buffer?.length) return Promise.resolve({ payload: buffer.shift() });
    return new Promise((resolve) =>
      this.listeners.set(type, [...(this.listeners.get(type) ?? []), resolve]),
    );
  }
}

export class TestWorkflowStep {
  constructor(hub) {
    this.hub = hub;
  }
  calls = [];
  cache = new Map();
  beforeWait = undefined;
  async do(name, config, callback) {
    this.calls.push({ name, config });
    if (!this.cache.has(name))
      this.cache.set(
        name,
        Promise.resolve()
          .then(callback)
          .then((value) => structuredClone(value)),
      );
    return structuredClone(await this.cache.get(name));
  }
  async waitForEvent(name, options) {
    this.calls.push({ name, options });
    if (!this.cache.has(name)) {
      this.cache.set(
        name,
        Promise.resolve()
          .then(() => this.beforeWait?.(name, options))
          .then(() => this.hub.wait(options.type)),
      );
    }
    return structuredClone(await this.cache.get(name));
  }
}

export function queueMessage(body, attempts = 1) {
  return {
    id: `message-${body.attemptId ?? "invalid"}`,
    body: structuredClone(body),
    attempts,
    timestamp: new Date(),
    acknowledged: false,
    retried: false,
    ack() {
      if (!this.retried) this.acknowledged = true;
    },
    retry() {
      if (!this.acknowledged) this.retried = true;
    },
  };
}

export function queueBatch(messages, name = "jobs") {
  return {
    queue: name,
    messages,
    ackAll() {
      messages.forEach((message) => message.ack());
    },
    retryAll() {
      messages.forEach((message) => message.retry());
    },
  };
}

export async function harness(t, options = {}) {
  const db = new TestDatabase();
  if (options.initialize !== false) await initOrdo(db);
  const hub = new EventHub();
  const step = new TestWorkflowStep(hub);
  const sent = [];
  const delivered = [];
  const pending = new Set();
  const destinations = [];
  const workflowBinding = {
    create: async () => ({ id: "workflow-1" }),
    get: async (id) => {
      destinations.push(id);
      return {
        sendEvent: (event) => hub.send(event),
        status: async () => ({ status: "running" }),
      };
    },
  };
  const context = {
    waitUntil(promise) {
      pending.add(promise);
      void promise.finally(() => pending.delete(promise));
    },
  };
  const runtime = {
    db,
    step,
    event: { workflowName: "test-workflow", instanceId: "workflow-1" },
    expiresIn: options.expiresIn,
    queue: {
      async send(body) {
        if (runtime.failDispatch-- > 0) throw new Error("Queue send failed");
        sent.push(structuredClone(body));
        await runtime.onSend?.(body);
        if (!runtime.dropDelivery) schedule(body, 1);
      },
    },
    failDispatch: 0,
    onSend: undefined,
    dropDelivery: false,
  };
  const configuration = {
    bindings: { db: db, queue: runtime.queue, workflow: workflowBinding },
    expiresIn: options.expiresIn,
  };
  const env = { DB: db, QUEUE: runtime.queue, WORKFLOW: workflowBinding };
  const consumer = new Ordo(env);
  let goalId;
  consumer.configure({ expiresIn: configuration.expiresIn });
  function schedule(body, number) {
    const message = queueMessage(body, number);
    delivered.push(message);
    const work = Promise.resolve()
      .then(() => consumer.queue(queueBatch([message]), {}, context))
      .then(() => {
        if (message.retried && number < 4) schedule(body, number + 1);
      });
    pending.add(work);
    void work.finally(() => pending.delete(work));
  }
  async function drain() {
    while (pending.size) await Promise.all([...pending]);
  }
  t.after(async () => {
    await drain();
    db.close();
  });
  return {
    db,
    hub,
    step,
    consumer,
    runtime,
    sent,
    delivered,
    drain,
    destinations,
    workflow: consumer,
    configuration,
    env,
    newDefinition(owner) {
      const definition = new Ordo(env, owner);
      definition.configure({ expiresIn: configuration.expiresIn });
      return definition;
    },
    async run(input) {
      goalId = await consumer.start(input);
      return consumer.run({ ...runtime.event, payload: { goalId } }, step);
    },
    async replay(definition, input) {
      goalId ??= await definition.start(input);
      return definition.run({ ...runtime.event, payload: { goalId } }, step);
    },
    async status() {
      return getGoalStatus(await getGoal(db, goalId));
    },
    goal() {
      return getGoal(db, goalId);
    },
    intent(attemptId, extra = {}) {
      return { protocol: "cfordo/2", attemptId, ...extra };
    },
  };
}

export function seedAttempt(db, options = {}) {
  const now = Date.now();
  const goalId =
    options.goalId ??
    Number(
      db.sqlite
        .prepare(
          `INSERT INTO cfordo_goals
    (workflow_name,instance_id,input_json,status,created_at,expires_at) VALUES (?, ?, ?, 'running', ?, ?)`,
        )
        .run(
          "test-workflow",
          options.instanceId ?? crypto.randomUUID(),
          JSON.stringify(options.input ?? {}),
          now,
          options.expiresAt ?? now + 86400000,
        ).lastInsertRowid,
    );
  const stepName = options.stepName ?? "extract";
  const attemptId = Number(
    db.sqlite
      .prepare(
        `INSERT INTO cfordo_attempts
    (goal_id,step_name,worker_name,action,source_run_id,predecessor_id,created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        goalId,
        stepName,
        stepName,
        options.action ?? "run",
        options.sourceRunId ?? null,
        options.predecessorId ?? null,
        now,
      ).lastInsertRowid,
  );
  return { goalId, attemptId };
}
