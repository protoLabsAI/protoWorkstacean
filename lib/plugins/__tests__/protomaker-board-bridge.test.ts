import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { InMemoryEventBus } from "../../bus.ts";
import {
  ProtoMakerBoardBridgePlugin,
  buildBoardIngestSignal,
} from "../protomaker-board-bridge.ts";
import type { ProjectRegistry } from "../../../src/plugins/project-registry.ts";
import type { GithubIssueOpenedPayload } from "../../../src/event-bus/payloads.ts";

const ISSUE: GithubIssueOpenedPayload = {
  owner: "protoLabsAI",
  repo: "protoContent",
  number: 12,
  action: "opened",
  title: "feat: content-idea intake endpoint",
  body: "POST a ContentIdea → idea stage.",
  author: "mabry1985",
  url: "https://github.com/protoLabsAI/protoContent/issues/12",
};

// Minimal registry stub — the bridge only calls getByGithub.
function fakeRegistry(known: Record<string, { slug: string; path: string }>): ProjectRegistry {
  return {
    getByGithub: (ownerRepo: string) => {
      const hit = known[ownerRepo.toLowerCase()];
      return hit ? ({ id: "x", name: hit.slug, slug: hit.slug, path: hit.path } as never) : undefined;
    },
  } as unknown as ProjectRegistry;
}

describe("buildBoardIngestSignal", () => {
  test("source=github, content=title+body, channelContext carries projectPath + dedup keys", () => {
    expect(buildBoardIngestSignal(ISSUE, "/home/josh/dev/contentMachine")).toEqual({
      source: "github",
      content: "feat: content-idea intake endpoint\n\nPOST a ContentIdea → idea stage.",
      channelContext: {
        projectPath: "/home/josh/dev/contentMachine",
        issueNumber: 12,
        repository: "protoLabsAI/protoContent",
      },
    });
  });

  test("falls back to a title when body is empty", () => {
    const out = buildBoardIngestSignal({ ...ISSUE, body: "" }, "/p");
    expect(out.content).toBe("feat: content-idea intake endpoint");
  });
});

describe("ProtoMakerBoardBridge — forward", () => {
  let origFetch: typeof globalThis.fetch;
  let calls: Array<{ url: string; body: unknown; apiKey: string | null }>;

  beforeEach(() => {
    origFetch = globalThis.fetch;
    calls = [];
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      const headers = new Headers(init?.headers);
      calls.push({ url, body: JSON.parse(String(init?.body ?? "{}")), apiKey: headers.get("X-API-Key") });
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }) as typeof globalThis.fetch;
  });
  afterEach(() => { globalThis.fetch = origFetch; });

  function publishIssue(bus: InMemoryEventBus, payload: GithubIssueOpenedPayload) {
    bus.publish("github.issue.opened", {
      id: "t", correlationId: "t", topic: "github.issue.opened", timestamp: Date.now(),
      payload,
    });
  }

  test("registered project repo → POSTs to /api/engine/signal/submit with resolved projectPath + key", async () => {
    const bus = new InMemoryEventBus();
    const registry = fakeRegistry({ "protolabsai/protocontent": { slug: "contentmachine", path: "/home/josh/dev/contentMachine" } });
    new ProtoMakerBoardBridgePlugin(registry, { baseUrl: "http://protomaker-server:3008", apiKey: "test-key" }).install(bus);

    publishIssue(bus, ISSUE);
    await Bun.sleep(15);

    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("http://protomaker-server:3008/api/engine/signal/submit");
    expect(calls[0]!.apiKey).toBe("test-key");
    expect(calls[0]!.body).toEqual({
      source: "github",
      content: "feat: content-idea intake endpoint\n\nPOST a ContentIdea → idea stage.",
      channelContext: { projectPath: "/home/josh/dev/contentMachine", issueNumber: 12, repository: "protoLabsAI/protoContent" },
    });
  });

  test("unregistered repo → no POST (workstacean triage owns it)", async () => {
    const bus = new InMemoryEventBus();
    const registry = fakeRegistry({}); // nothing registered
    new ProtoMakerBoardBridgePlugin(registry, { baseUrl: "http://x", apiKey: "k" }).install(bus);

    publishIssue(bus, ISSUE);
    await Bun.sleep(15);

    expect(calls).toHaveLength(0);
  });

  test("missing API key → no POST, no throw", async () => {
    const bus = new InMemoryEventBus();
    const registry = fakeRegistry({ "protolabsai/protocontent": { slug: "contentmachine", path: "/p" } });
    new ProtoMakerBoardBridgePlugin(registry, { baseUrl: "http://x", apiKey: "" }).install(bus);

    publishIssue(bus, ISSUE);
    await Bun.sleep(15);

    expect(calls).toHaveLength(0);
  });
});
