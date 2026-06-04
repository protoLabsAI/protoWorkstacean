/**
 * Fleet role bindings — the one place that maps abstract roles (helm, reviewer,
 * remediator) to concrete agent names, plus the reviewer's GitHub bot-login
 * identities. Lets a fork re-skin the fleet by editing `workspace/fleet.yaml`
 * instead of the dispatch/review/remediation code, which used to hardcode
 * `ava` / `quinn` / `roxy` / `protoquinn`.
 *
 * Defaults are the proto-labs fleet's values, so an unmodified deploy needs no
 * fleet.yaml. A fork drops one in:
 *
 *   roles:
 *     helm: bob          # default target for untargeted requests + the chat model alias
 *     reviewer: carol    # PR-review agent
 *     remediator: dave   # feature.blocked unblock agent
 *   github:
 *     reviewerBotLogins: [carolbot, "carolbot[bot]"]   # the reviewer's own GitHub identities
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { logger } from "../log.ts";

const log = logger("fleet");

export interface FleetConfig {
  /** Default target for untargeted inbound requests + the OpenAI-compat chat alias. */
  helm: string;
  /** Agent that runs PR review. */
  reviewer: string;
  /** Agent dispatched to unblock a blocked feature. */
  remediator: string;
  /** GitHub login bases identifying the reviewer's OWN reviews (so the review loop matches them). */
  reviewerBotLogins: string[];
}

export const FLEET_DEFAULTS: FleetConfig = {
  helm: "ava",
  reviewer: "quinn",
  remediator: "roxy",
  reviewerBotLogins: ["protoquinn", "protoquinn[bot]"],
};

interface RawFleet {
  roles?: Partial<Record<"helm" | "reviewer" | "remediator", string>>;
  github?: { reviewerBotLogins?: string[] };
}

/** Load + merge `workspace/fleet.yaml` over the defaults. Never throws. */
export function loadFleetConfig(workspaceDir: string = process.env.WORKSPACE_DIR ?? "workspace"): FleetConfig {
  const path = join(workspaceDir, "fleet.yaml");
  if (!existsSync(path)) return { ...FLEET_DEFAULTS };
  try {
    const raw = (parseYaml(readFileSync(path, "utf8")) as RawFleet) ?? {};
    const logins = raw.github?.reviewerBotLogins;
    return {
      helm: raw.roles?.helm?.trim() || FLEET_DEFAULTS.helm,
      reviewer: raw.roles?.reviewer?.trim() || FLEET_DEFAULTS.reviewer,
      remediator: raw.roles?.remediator?.trim() || FLEET_DEFAULTS.remediator,
      reviewerBotLogins: Array.isArray(logins) && logins.length ? logins : FLEET_DEFAULTS.reviewerBotLogins,
    };
  } catch (e) {
    log.warn("failed to parse fleet.yaml — using defaults", { err: e });
    return { ...FLEET_DEFAULTS };
  }
}

let cached: FleetConfig | null = null;

/** Process-wide fleet config (loaded once). */
export function getFleetConfig(): FleetConfig {
  if (!cached) cached = loadFleetConfig();
  return cached;
}

/** Test hook — inject a config or reset to force a reload. */
export function setFleetConfigForTesting(config?: FleetConfig): void {
  cached = config ?? null;
}
