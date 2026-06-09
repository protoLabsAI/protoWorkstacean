/**
 * Route definitions (ADR-0008 P2 — wiring authoring).
 *
 * A route is the canvas's authorable unit of WIRING: "when this bus topic
 * fires, dispatch this skill to this agent." One file per route in
 * `workspace/routes.d/<name>.yaml`, hot-reloaded like agents.d/. A route is a
 * single pub/sub hop — it carries NO payload transform, NO conditionals, NO
 * `output→input` logic (that boundary is ADR-0008 D1/D5). The triggering
 * payload passes through untouched; the agent decides what to do.
 *
 * This module is pure (parse / validate / load / serialize) so the loader and
 * the control-plane API share one definition of "a valid route".
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

export interface RouteDefinition {
  /** Unique, filename-safe (kebab). Names the routes.d/<name>.yaml file. */
  name: string;
  description?: string;
  /** The trigger: a bus topic pattern (the bus's `#`/`*` matcher). */
  when: { topic: string };
  /** The reaction: dispatch `skill` (optionally to a specific `agent`). */
  then: { skill: string; agent?: string };
  /** Absence = enabled. `false` greys the route on the canvas without deleting it. */
  enabled?: boolean;
}

const NAME_RE = /^[a-z0-9][a-z0-9._-]*$/i;

/**
 * Topics a route may NOT trigger on — they would re-enter the dispatch the
 * route itself produces and loop. `agent.skill.request` is the dispatch topic;
 * `#` matches everything (including it). Narrower self-loops are still bounded
 * by the dispatcher's cooldown + self-cascade guard.
 */
const FORBIDDEN_TRIGGERS = new Set(["#", "agent.skill.request"]);

/**
 * Validate a raw object into a RouteDefinition. Throws on invalid input — the
 * control-plane API turns the throw into a 400; the loader catches + skips.
 */
export function parseRouteDefinition(raw: unknown, source = "(route)"): RouteDefinition {
  const r = (raw ?? {}) as Record<string, unknown>;
  const fail = (msg: string): never => { throw new Error(`${source}: ${msg}`); };

  if (typeof r.name !== "string" || !NAME_RE.test(r.name)) fail("name is required and must be filename-safe (a-z, 0-9, . _ -)");
  const when = (r.when ?? {}) as Record<string, unknown>;
  if (typeof when.topic !== "string" || when.topic.trim() === "") fail("when.topic (a bus topic pattern) is required");
  if (FORBIDDEN_TRIGGERS.has((when.topic as string).trim())) fail(`when.topic "${when.topic}" would loop the dispatch — pick a narrower trigger`);
  const then = (r.then ?? {}) as Record<string, unknown>;
  if (typeof then.skill !== "string" || then.skill.trim() === "") fail("then.skill is required");
  if (then.agent !== undefined && (typeof then.agent !== "string" || then.agent.trim() === "")) fail("then.agent, when set, must be a non-empty string");
  if (r.enabled !== undefined && typeof r.enabled !== "boolean") fail("enabled, when set, must be a boolean");

  const def: RouteDefinition = {
    name: (r.name as string).trim(),
    when: { topic: (when.topic as string).trim() },
    then: { skill: (then.skill as string).trim(), ...(then.agent ? { agent: (then.agent as string).trim() } : {}) },
  };
  if (typeof r.description === "string" && r.description.trim()) def.description = r.description.trim();
  if (r.enabled !== undefined) def.enabled = r.enabled as boolean;
  return def;
}

/** Serialize a route to its canonical YAML file contents. */
export function routeToYaml(def: RouteDefinition): string {
  return stringifyYaml(def);
}

/**
 * Load every route in `routesdDir`. Tolerant: a malformed file is skipped (and
 * surfaced via onSkip) rather than failing the whole load — one bad route must
 * never take down routing. Returns [] if the directory is absent.
 */
export function loadRouteEntries(routesdDir: string, onSkip?: (file: string, err: unknown) => void): RouteDefinition[] {
  if (!existsSync(routesdDir)) return [];
  const out: RouteDefinition[] = [];
  for (const file of readdirSync(routesdDir)) {
    if (!/\.ya?ml$/.test(file) || file.endsWith(".example")) continue;
    try {
      out.push(parseRouteDefinition(parseYaml(readFileSync(join(routesdDir, file), "utf8")), file));
    } catch (err) {
      onSkip?.(file, err);
    }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}
