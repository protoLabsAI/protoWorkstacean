/**
 * SkillBroker card↔yaml reconciliation. The load-bearing invariant: yaml-declared
 * skills (the agents.yaml `skills:` block) are OVERRIDES — card discovery never
 * prunes them, even when the agent's card doesn't advertise them. Regression for
 * the Roxy case: her card advertised only `chat`, which used to prune her
 * yaml-declared portfolio skills on the first 10-min refresh.
 */

import { describe, test, expect } from "bun:test";
import { reconcileCardSkills } from "../skill-broker-plugin.ts";

const S = (...xs: string[]) => new Set(xs);

describe("reconcileCardSkills", () => {
  test("yaml overrides are never pruned, even when absent from the card", () => {
    // Roxy: card advertises only `chat`; yaml declares the 4 portfolio skills.
    const yaml = S("portfolio_sitrep", "board_sweep", "project_decompose", "unblock_feature");
    const { toAdd, toRemove } = reconcileCardSkills(/*prevCard*/ S(), yaml, /*card*/ S("chat"));
    expect(toAdd).toEqual(["chat"]);          // chat is a new card skill
    expect(toRemove).toEqual([]);             // none of the yaml skills are pruned
  });

  test("a yaml skill that's also on the card is kept when the card later drops it", () => {
    const yaml = S("portfolio_sitrep");
    // previously the card also advertised portfolio_sitrep; now it doesn't.
    const { toRemove } = reconcileCardSkills(S("portfolio_sitrep", "chat"), yaml, S("chat"));
    expect(toRemove).toEqual([]);             // portfolio_sitrep is a yaml override → kept
  });

  test("genuinely card-only skills are still pruned when they drop off the card", () => {
    const { toAdd, toRemove } = reconcileCardSkills(S("passive_recon", "active_pentest"), S(), S("passive_recon"));
    expect(toAdd).toEqual([]);
    expect(toRemove).toEqual(["active_pentest"]); // no longer advertised, not a yaml override → pruned
  });

  test("new card skills are added; yaml skills are not re-added (already registered)", () => {
    const yaml = S("chat");
    const { toAdd, toRemove } = reconcileCardSkills(S(), yaml, S("chat", "summarize"));
    expect(toAdd).toEqual(["summarize"]);     // chat is a yaml override → not re-added
    expect(toRemove).toEqual([]);
  });
});
