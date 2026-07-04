/**
 * Runtime-environment helpers shared across plugins + the HTTP layer.
 *
 * Centralizes (a) the "are we production-like?" check used to fail-closed on
 * missing secrets, (b) a constant-time key comparison, and (c) the `/publish`
 * topic denylist that stops the external bus-injection ingress from forging
 * internal control-plane events. Lives in `lib/` so both `lib/` plugins and
 * `src/` can import it.
 */

import { timingSafeEqual } from "node:crypto";

/**
 * True when the process is running in (or pointed at) a production deployment.
 * Used to refuse to start with auth/webhook secrets unset rather than silently
 * exposing an open surface.
 */
export function isProductionLike(env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.NODE_ENV === "production") return true;
  if (env.WORKSTACEAN_PUBLIC_BASE_URL) return true;
  return false;
}

/** Constant-time string compare. Returns false on null/length-mismatch (no early-out leak). */
export function safeKeyEqual(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return false;
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

/**
 * Topic prefixes that may NOT be injected through the external `/publish`
 * ingress. These are internal control-plane topics — forging them would let a
 * caller drive executors, spoof the operator, fake inbound user messages, or
 * trigger scheduled work. Legitimate external publishers (`hitl.request.*`
 * and agents' incident events) are unaffected. Overridable via
 * `WORKSTACEAN_PUBLISH_TOPIC_DENYLIST` (CSV).
 */
export const PUBLISH_TOPIC_DENYLIST_DEFAULT: readonly string[] = [
  "agent.skill.request",
  "agent.skill.response",
  "agent.input.",
  "operator.message.request",
  "message.inbound.",
  "cron.",
  "command.",
  "autonomous.",
  "ceremony.",
  "dispatch.",
];

export function publishDenylistFromEnv(env: NodeJS.ProcessEnv = process.env): readonly string[] {
  const override = env.WORKSTACEAN_PUBLISH_TOPIC_DENYLIST;
  if (override && override.trim()) {
    return override.split(",").map((s) => s.trim()).filter(Boolean);
  }
  return PUBLISH_TOPIC_DENYLIST_DEFAULT;
}

/** True if `topic` matches a denied prefix and must be rejected at `/publish`. */
export function isPublishTopicDenied(topic: string, denylist: readonly string[] = publishDenylistFromEnv()): boolean {
  return denylist.some((p) => topic === p || topic.startsWith(p));
}
