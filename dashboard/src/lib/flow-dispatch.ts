/**
 * In-flight dispatch tracking for the canvas (ADR-0008 WS-3b).
 *
 * The hub's authoritative dispatch signal is `flow.item.*` — every dispatch,
 * builtin or A2A, flows through the SkillDispatcher and emits created → (updated)*
 * → completed. We fold them into a set of agent names that currently have a live
 * dispatch, so SystemGraph animates the host→agent edge uniformly across tiers
 * (a dispatch to a distributed A2A agent animates the same as an in-process one —
 * it all flows through the one hub).
 */

export interface FlowDispatchItem {
  status?: "active" | "blocked" | "complete";
  stage?: "dispatched" | "running" | "error" | "done";
  meta?: { targetAgent?: unknown };
}

/** A flow.item.* event is terminal on completion or error. */
function isTerminal(topic: string, item: FlowDispatchItem): boolean {
  return (
    topic === "flow.item.completed"
    || item.status === "complete"
    || item.status === "blocked"
    || item.stage === "done"
    || item.stage === "error"
  );
}

/**
 * Fold one `flow.item.*` event into the in-flight set. Returns the SAME set
 * reference when nothing changed (so React can bail out of a re-render), a new
 * set otherwise. Events without a non-empty string `targetAgent`
 * (function/ceremony dispatches) are inert.
 */
export function applyFlowDispatch(current: Set<string>, topic: string, item: FlowDispatchItem): Set<string> {
  const agent = item?.meta?.targetAgent;
  if (typeof agent !== "string" || agent === "") return current;

  if (isTerminal(topic, item)) {
    if (!current.has(agent)) return current;
    const next = new Set(current);
    next.delete(agent);
    return next;
  }

  if (current.has(agent)) return current;
  const next = new Set(current);
  next.add(agent);
  return next;
}
