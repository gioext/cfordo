import { SCHEMA_VERSION } from "../db/schema.ts";
import { reserveDispatch } from "../db/store.ts";
import type { Attempt, OrdoEnv } from "../types.ts";

export async function dispatchStep(
  env: OrdoEnv,
  goalId: number,
  stepName: string,
  delivery: Attempt | undefined,
  last: Attempt | undefined,
  recover: boolean,
  expiresIn: number,
): Promise<void> {
  const id = await reserveDispatch(
    env.DB,
    goalId,
    stepName,
    delivery,
    last,
    recover,
    expiresIn,
  );
  if (id === null) return;
  // An ambiguous send leaves the recorded dispatch for the planner to recover.
  await env.QUEUE.send({
    protocol: "cfordo/7",
    schemaVersion: SCHEMA_VERSION,
    deliveryId: id,
  });
}
