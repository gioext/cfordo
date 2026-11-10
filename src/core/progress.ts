import { DELIVERY_TIMEOUT, EXECUTION_TIMEOUT } from "../db/store.ts";
import type {
  Action,
  Attempt,
  CheckResult,
  CheckSource,
  RegisteredStep,
} from "../types.ts";

export function verdict(item: Attempt | undefined): CheckResult | null {
  return item?.action === "validate" || item?.action === "evaluate"
    ? ((item.output as CheckResult | undefined) ?? null)
    : null;
}
export function improvement(
  item: Attempt | undefined,
): { source: CheckSource; reason: string } | null {
  const check = verdict(item);
  return item?.status === "completed" && check?.ok === false
    ? { source: item.action as CheckSource, reason: check.reason }
    : null;
}
export function followingAction(
  item: Attempt,
  definition: RegisteredStep | undefined,
): Action | null {
  if (verdict(item)?.ok === false) return null;
  if (item.action === "run")
    return definition?.validate
      ? "validate"
      : definition?.evaluate
        ? "evaluate"
        : null;
  if (item.action === "validate")
    return definition?.evaluate ? "evaluate" : null;
  return null;
}
export function feedback(history: readonly Attempt[]) {
  const rejected = history.filter((item) => improvement(item));
  const prior = improvement(rejected.at(-1));
  return {
    iteration: rejected.length + 1,
    source: prior?.source ?? null,
    reason: prior?.reason ?? null,
  };
}
export function stepProgress(
  history: readonly Attempt[],
  definition: RegisteredStep | undefined,
  maxIterations: number,
  now = Date.now(),
) {
  const delivery = history.filter((a) => a.action === null).at(-1);
  const execution = delivery
    ? history.filter((a) => a.deliveryId === delivery.id && a.action !== null)
    : [];
  const last = execution.at(-1);
  const rejected = improvement(last);
  let status: "ready" | "running" | "completed" | "failed" = delivery
    ? "running"
    : "ready";
  let dispatch: "initial" | "improve" | "recover" | null = delivery
    ? null
    : "initial";
  let action: Action | null = last?.action ?? (delivery ? "run" : null);
  let finishedAt: number | null = null;
  if (last?.status === "failed") {
    status = "failed";
    action = null;
    finishedAt = last.finishedAt;
  } else if (rejected) {
    if (history.filter((item) => improvement(item)).length >= maxIterations) {
      status = "failed";
      action = null;
      finishedAt = last!.finishedAt;
    } else {
      dispatch = "improve";
      action = "run";
    }
  } else if (
    last?.status === "completed" &&
    followingAction(last, definition) === null
  ) {
    status = "completed";
    action = null;
    finishedAt = last.finishedAt;
  } else if (
    delivery &&
    (last
      ? last.status === "expired" ||
        now >= last.runCreatedAt! + EXECUTION_TIMEOUT
      : now >= delivery.createdAt + DELIVERY_TIMEOUT)
  ) {
    dispatch = "recover";
    action = "run";
  }
  return {
    status,
    action,
    dispatch,
    delivery,
    execution,
    last,
    rejected,
    finishedAt,
  };
}
