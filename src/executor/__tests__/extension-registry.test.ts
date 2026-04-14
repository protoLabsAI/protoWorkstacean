/**
 * Phase 8 — ExtensionRegistry foundation.
 *
 * These tests cover the registry's core matching + header generation logic.
 * They don't cover any specific extension behavior (none shipped yet) — that
 * comes in future phases when we implement cost/consent/etc.
 */

import { describe, test, expect } from "bun:test";
import type { AgentCard } from "@a2a-js/sdk";
import { ExtensionRegistry, type ExtensionInterceptor } from "../extension-registry.ts";

function cardWithExtensions(uris: string[]): AgentCard {
  return {
    name: "fake",
    description: "test",
    protocolVersion: "0.3.0",
    version: "1.0.0",
    url: "http://localhost/a2a",
    preferredTransport: "JSONRPC",
    defaultInputModes: ["text/plain"],
    defaultOutputModes: ["text/plain"],
    capabilities: { extensions: uris.map(uri => ({ uri })) },
    skills: [],
  };
}

describe("ExtensionRegistry", () => {
  test("matchAgent returns empty when agent has no extensions", () => {
    const reg = new ExtensionRegistry();
    reg.register({ uri: "https://example.com/ext/x" });
    const card = cardWithExtensions([]);
    expect(reg.matchAgent(card)).toEqual([]);
  });

  test("matchAgent returns only registered extensions advertised by agent", () => {
    const reg = new ExtensionRegistry();
    reg.register({ uri: "https://example.com/ext/cost" });
    reg.register({ uri: "https://example.com/ext/consent" });
    const card = cardWithExtensions([
      "https://example.com/ext/cost",
      "https://example.com/ext/unknown", // not registered — must be ignored
    ]);
    const matches = reg.matchAgent(card);
    expect(matches.map(m => m.uri)).toEqual(["https://example.com/ext/cost"]);
  });

  test("headersFor emits comma-separated a2a-extensions opt-in list", () => {
    const reg = new ExtensionRegistry();
    reg.register({ uri: "https://example.com/ext/cost" });
    reg.register({ uri: "https://example.com/ext/consent" });
    const card = cardWithExtensions([
      "https://example.com/ext/cost",
      "https://example.com/ext/consent",
    ]);
    const headers = reg.headersFor(card);
    expect(headers).toEqual({
      "a2a-extensions": "https://example.com/ext/cost, https://example.com/ext/consent",
    });
  });

  test("headersFor returns empty object when no matches", () => {
    const reg = new ExtensionRegistry();
    reg.register({ uri: "https://example.com/ext/cost" });
    const card = cardWithExtensions([]);
    expect(reg.headersFor(card)).toEqual({});
  });

  test("interceptorsFor filters only extensions with interceptors", () => {
    const reg = new ExtensionRegistry();
    const costInterceptor: ExtensionInterceptor = { before: async () => {} };
    reg.register({ uri: "https://example.com/ext/cost", interceptor: costInterceptor });
    reg.register({ uri: "https://example.com/ext/plain" }); // no interceptor
    const card = cardWithExtensions([
      "https://example.com/ext/cost",
      "https://example.com/ext/plain",
    ]);
    const interceptors = reg.interceptorsFor(card);
    expect(interceptors).toHaveLength(1);
    expect(interceptors[0]).toBe(costInterceptor);
  });

  test("null/undefined card is safe", () => {
    const reg = new ExtensionRegistry();
    reg.register({ uri: "https://example.com/ext/cost" });
    expect(reg.matchAgent(undefined)).toEqual([]);
    expect(reg.matchAgent(null)).toEqual([]);
    expect(reg.headersFor(undefined)).toEqual({});
  });
});
