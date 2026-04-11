/**
 * Fire-and-forget skills — skills whose dispatch is owned entirely by the
 * workspace A2A plugin (workspace/plugins/a2a.ts), NOT the router + skill
 * dispatcher pipeline.
 *
 * These skills involve multi-step orchestration (external API chains, LLM
 * plan-then-review loops) where the inbound message should be ack'd
 * immediately and the agent posts back to the reply topic when done. The
 * workspace a2a plugin has its own in-flight guard and ack pattern tuned
 * for this shape.
 *
 * Why this matters: both the router and the workspace a2a plugin subscribe
 * to `message.inbound.#`. Without symmetric filtering, a FAF skill would
 * be dispatched twice — once through skill-dispatcher (blocks, holds a
 * request slot) and once through the workspace plugin (acks immediately).
 * The workspace plugin's inFlightFAF map masks the visible double-run but
 * is race-prone. The correct fix is for the router to skip these skills
 * entirely so only the workspace plugin handles them.
 *
 * Both files import this set so the allowlist can never drift.
 */
export const FIRE_AND_FORGET_SKILLS: ReadonlySet<string> = new Set([
  "onboard_project",
  "plan",
  "plan_resume",
  "deep_research",
]);
