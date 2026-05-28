import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, existsSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  LinearAvaTokenManager,
  buildAuthorizeUrl,
  needsRefresh,
} from "../ava-oauth-token-manager.ts";

const CFG = {
  clientId: "client-abc",
  clientSecret: "secret-xyz",
  redirectUri: "https://api.protolabs.studio/api/linear/oauth/callback",
};

describe("buildAuthorizeUrl", () => {
  test("includes actor=app, redirect, scopes, state", () => {
    const url = new URL(buildAuthorizeUrl({ clientId: "c1", redirectUri: "https://x/cb" }, "st8"));
    expect(url.origin + url.pathname).toBe("https://linear.app/oauth/authorize");
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("client_id")).toBe("c1");
    expect(url.searchParams.get("redirect_uri")).toBe("https://x/cb");
    expect(url.searchParams.get("actor")).toBe("app");
    expect(url.searchParams.get("state")).toBe("st8");
    expect(url.searchParams.get("scope")).toContain("app:assignable");
  });

  test("honors custom scopes", () => {
    const url = new URL(buildAuthorizeUrl({ clientId: "c", redirectUri: "https://x", scopes: "read" }, "s"));
    expect(url.searchParams.get("scope")).toBe("read");
  });
});

describe("needsRefresh", () => {
  const now = 1_000_000_000_000;
  test("true when expired", () => expect(needsRefresh({ expiresAt: now - 1 }, now)).toBe(true));
  test("true when within 5-min margin", () => expect(needsRefresh({ expiresAt: now + 60_000 }, now)).toBe(true));
  test("false when comfortably valid", () => expect(needsRefresh({ expiresAt: now + 3_600_000 }, now)).toBe(false));
});

describe("LinearAvaTokenManager", () => {
  let dataDir: string;
  let fetchCalls: Array<{ url: string; body: Record<string, string> }>;
  let nextResponse: () => Response;

  function mockFetch(): typeof fetch {
    return (async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      const body = Object.fromEntries(new URLSearchParams(String(init?.body ?? "")));
      fetchCalls.push({ url, body });
      return nextResponse();
    }) as typeof fetch;
  }

  function tokenResponse(over: Record<string, unknown> = {}): Response {
    return new Response(JSON.stringify({ access_token: "at-1", refresh_token: "rt-1", expires_in: 86399, ...over }), { status: 200 });
  }

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), "linear-ava-oauth-"));
    fetchCalls = [];
    nextResponse = () => tokenResponse();
  });
  afterEach(() => {
    try { rmSync(dataDir, { recursive: true, force: true }); } catch { /* best effort */ }
  });

  function mgr() {
    return new LinearAvaTokenManager(dataDir, CFG, mockFetch());
  }

  test("isConfigured true with creds; isAuthorized false until a token is stored", () => {
    const m = mgr();
    expect(m.isConfigured()).toBe(true);
    expect(m.isAuthorized()).toBe(false);
    expect(m.status()).toEqual({ configured: true, authorized: false, expiresAt: null });
  });

  test("not configured when creds missing", () => {
    const m = new LinearAvaTokenManager(dataDir, { clientId: "only-id" }, mockFetch());
    expect(m.isConfigured()).toBe(false);
  });

  test("startAuthorization persists pendingState and the callback validates it", async () => {
    const m = mgr();
    const url = new URL(m.startAuthorization());
    const state = url.searchParams.get("state")!;
    expect(state).toBeTruthy();

    // Wrong state → rejected (CSRF guard).
    await expect(m.handleCallback("code-1", "WRONG")).rejects.toThrow(/state mismatch/i);

    // Correct state → exchange happens.
    await m.handleCallback("code-1", state);
    expect(m.isAuthorized()).toBe(true);
    const exchange = fetchCalls.find(c => c.body.grant_type === "authorization_code")!;
    expect(exchange.url).toBe("https://api.linear.app/oauth/token");
    expect(exchange.body).toMatchObject({
      grant_type: "authorization_code",
      code: "code-1",
      client_id: "client-abc",
      client_secret: "secret-xyz",
      redirect_uri: CFG.redirectUri,
    });
  });

  test("handleCallback throws when no refresh_token comes back", async () => {
    const m = mgr();
    nextResponse = () => tokenResponse({ refresh_token: undefined });
    await expect(m.handleCallback("c", null)).rejects.toThrow(/no refresh_token/i);
  });

  test("getAccessToken returns stored token without refreshing while valid", async () => {
    const m = mgr();
    await m.handleCallback("c", null); // stores at-1, ~24h
    fetchCalls.length = 0;
    const tok = await m.getAccessToken();
    expect(tok).toBe("at-1");
    expect(fetchCalls).toHaveLength(0); // no refresh needed
  });

  test("getAccessToken refreshes when expired and rotates the refresh token", async () => {
    const m = mgr();
    await m.handleCallback("c", null);
    fetchCalls.length = 0;
    nextResponse = () => tokenResponse({ access_token: "at-2", refresh_token: "rt-2" });

    const tok = await m.getAccessToken(Date.now() + 100 * 3_600_000); // far future → expired
    expect(tok).toBe("at-2");
    const refresh = fetchCalls.find(c => c.body.grant_type === "refresh_token")!;
    expect(refresh.body.refresh_token).toBe("rt-1"); // used the original
    expect(m.status().authorized).toBe(true);
  });

  test("keeps the old refresh token when refresh response omits a new one", async () => {
    const m = mgr();
    await m.handleCallback("c", null);
    nextResponse = () => tokenResponse({ access_token: "at-3", refresh_token: undefined });
    await m.getAccessToken(Date.now() + 100 * 3_600_000);
    // Next refresh must still send rt-1.
    fetchCalls.length = 0;
    await m.getAccessToken(Date.now() + 200 * 3_600_000);
    expect(fetchCalls[0]!.body.refresh_token).toBe("rt-1");
  });

  test("getAccessToken throws before authorization", async () => {
    const m = mgr();
    await expect(m.getAccessToken()).rejects.toThrow(/not authorized/i);
  });

  test("tokens persist to disk and reload in a fresh instance", async () => {
    const m1 = mgr();
    await m1.handleCallback("c", null);
    expect(existsSync(join(dataDir, "linear-ava-oauth.json"))).toBe(true);

    const m2 = new LinearAvaTokenManager(dataDir, CFG, mockFetch());
    expect(m2.isAuthorized()).toBe(true);
    const tok = await m2.getAccessToken();
    expect(tok).toBe("at-1");
  });

  test("token file is written with 0600 perms (no world/group read)", async () => {
    const m = mgr();
    await m.handleCallback("c", null);
    const perms = statSync(join(dataDir, "linear-ava-oauth.json")).mode & 0o777;
    expect(perms).toBe(0o600);
  });
});
