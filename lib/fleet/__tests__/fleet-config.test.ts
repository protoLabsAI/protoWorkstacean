import { describe, expect, test, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadFleetConfig, FLEET_DEFAULTS } from "../fleet-config.ts";

const dirs: string[] = [];
function ws(yaml?: string): string {
  const d = mkdtempSync(join(tmpdir(), "fleet-"));
  dirs.push(d);
  if (yaml !== undefined) writeFileSync(join(d, "fleet.yaml"), yaml);
  return d;
}
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

describe("loadFleetConfig", () => {
  test("returns proto-labs defaults when no fleet.yaml exists", () => {
    expect(loadFleetConfig(ws())).toEqual(FLEET_DEFAULTS);
  });

  test("merges role + reviewerBotLogins overrides over defaults", () => {
    const cfg = loadFleetConfig(ws(`
roles:
  helm: bob
  reviewer: carol
github:
  reviewerBotLogins: [carolbot, "carolbot[bot]"]
`));
    expect(cfg.helm).toBe("bob");
    expect(cfg.reviewer).toBe("carol");
    expect(cfg.reviewerBotLogins).toEqual(["carolbot", "carolbot[bot]"]);
  });

  test("falls back to defaults on malformed yaml (never throws)", () => {
    expect(loadFleetConfig(ws("roles: [this is: not valid: ]]"))).toMatchObject({ helm: "ava" });
  });
});
