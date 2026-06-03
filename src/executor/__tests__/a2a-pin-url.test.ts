import { describe, test, expect } from "bun:test";
import { pinCardTransportUrl } from "../executors/a2a-executor.ts";
import type { AgentCard } from "@a2a-js/sdk";

// The #760 regression: an agent self-advertised http://127.0.0.1:7870/a2a in its
// card, so the hub's A2A client dialed loopback (itself) instead of the agent.
// pinCardTransportUrl makes the configured (reachable) agents.d URL authoritative
// for the connection while leaving the card intact for discovery.

const CONFIGURED = "http://roxy:7870/a2a";

function cardWithIfaceUrl(url: string): AgentCard {
  return {
    name: "roxy",
    supportedInterfaces: [
      { url, protocolBinding: "JSONRPC", protocolVersion: "1.0", tenant: "" },
    ],
  } as unknown as AgentCard;
}

describe("pinCardTransportUrl (#760)", () => {
  test("rewrites a loopback interface URL to the configured URL", () => {
    const pinned = pinCardTransportUrl(cardWithIfaceUrl("http://127.0.0.1:7870/a2a"), CONFIGURED);
    expect(pinned.supportedInterfaces?.[0]?.url).toBe(CONFIGURED);
  });

  test("preserves the other interface fields (binding/version)", () => {
    const pinned = pinCardTransportUrl(cardWithIfaceUrl("http://127.0.0.1:7870/a2a"), CONFIGURED);
    expect(pinned.supportedInterfaces?.[0]?.protocolBinding).toBe("JSONRPC");
    expect(pinned.supportedInterfaces?.[0]?.protocolVersion).toBe("1.0");
    expect(pinned.name).toBe("roxy");
  });

  test("does NOT mutate the input card", () => {
    const card = cardWithIfaceUrl("http://127.0.0.1:7870/a2a");
    pinCardTransportUrl(card, CONFIGURED);
    expect(card.supportedInterfaces?.[0]?.url).toBe("http://127.0.0.1:7870/a2a");
  });

  test("pins the legacy top-level url field if present", () => {
    const card = { name: "x", url: "http://127.0.0.1:7870/a2a" } as unknown as AgentCard;
    const pinned = pinCardTransportUrl(card, CONFIGURED) as { url?: string };
    expect(pinned.url).toBe(CONFIGURED);
  });

  test("no supportedInterfaces → returns a copy, no throw", () => {
    const card = { name: "x" } as unknown as AgentCard;
    expect(() => pinCardTransportUrl(card, CONFIGURED)).not.toThrow();
  });
});
