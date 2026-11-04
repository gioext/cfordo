import { assertJson } from "./core/validation.ts";
import { Hono } from "hono";
import { GoalNotFoundError } from "./db/store.ts";
import { GoalReadError, GoalStartError } from "./core/goal.ts";
import type { GoalDetail, GoalSummary, OrdoEnv } from "./types.ts";

interface Goals {
  start(input: unknown): Promise<number>;
  list(): Promise<GoalSummary[]>;
  get(id: number): Promise<GoalDetail>;
}

export function createApi<Env extends OrdoEnv>(
  resolve: (env: Env, ctx: ExecutionContext) => Promise<Goals>,
) {
  const app = new Hono<{ Bindings: Env }>();
  app.onError((error, c) => {
    if (error instanceof GoalNotFoundError)
      return c.json(
        { error: { code: "GoalNotFound", message: error.message } },
        404,
      );
    if (error instanceof GoalStartError)
      return c.json(
        {
          goalId: error.goalId,
          error: { code: "StartUnconfirmed", message: error.message },
        },
        503,
      );
    if (error instanceof GoalReadError)
      return c.json(
        { error: { code: "StatusUnavailable", message: error.message } },
        503,
      );
    console.error("Ordo API failed", error);
    return c.json(
      { error: { code: "InternalError", message: "Goal request failed" } },
      500,
    );
  });
  app.notFound((c) =>
    c.json({ error: { code: "NotFound", message: "Endpoint not found" } }, 404),
  );
  app.post("/_ordo/goals", async (c) => {
    let input: unknown;
    try {
      input = await c.req.json();
      assertJson(input, "Goal input");
    } catch {
      return c.json(
        {
          error: { code: "InvalidInput", message: "Request body must be JSON" },
        },
        400,
      );
    }
    const goals = await resolve(c.env, c.executionCtx as ExecutionContext);
    const goalId = await goals.start(input);
    c.header("Location", `/_ordo/goals/${goalId}`);
    return c.json({ goalId }, 202);
  });
  app.get("/_ordo/goals", async (c) => {
    const goals = await resolve(c.env, c.executionCtx as ExecutionContext);
    return c.json(await goals.list());
  });
  app.get("/_ordo/goals/:goalId", async (c) => {
    const raw = c.req.param("goalId");
    const id = Number(raw);
    if (!/^[1-9]\d*$/.test(raw) || !Number.isSafeInteger(id))
      return c.json(
        {
          error: {
            code: "InvalidGoalId",
            message: "Goal ID must be a positive integer",
          },
        },
        400,
      );
    const goals = await resolve(c.env, c.executionCtx as ExecutionContext);
    return c.json(await goals.get(id));
  });
  return app;
}
