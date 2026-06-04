/**
 * LinearAvaTokenManager — owns Ava's Linear agent (actor=app) OAuth tokens.
 *
 * Why this exists: workstacean's default LINEAR_API_KEY is Josh's personal key,
 * so anything it writes is authored by Josh. To post AS Ava (the Linear agent
 * app, actor email …@oauthapp.linear.app) we use an actor=app OAuth token.
 *
 * Linear migrated all OAuth apps to the refresh-token system on 2026-04-01:
 * access tokens live ~24h. So there is no static token to store — we hold the
 * client creds + a long-lived refresh token, and mint short-lived access tokens
 * on demand (refreshing before expiry). The refresh token is captured once via
 * the /api/linear/oauth/callback dance and persisted to the data volume so it
 * survives restarts.
 *
 * Piece A (this file + the callback routes) gets the token captured + kept
 * fresh + exposed via getAccessToken(). Piece B (posting agent activity as Ava)
 * consumes getAccessToken().
 *
 * Endpoints (Linear, verified):
 *   authorize: GET  https://linear.app/oauth/authorize
 *   token:     POST https://api.linear.app/oauth/token   (code + refresh grants)
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { logger } from "../log.ts";

const log = logger("linear-ava-oauth");

const AUTHORIZE_URL = "https://linear.app/oauth/authorize";
const TOKEN_URL = "https://api.linear.app/oauth/token";
/** Refresh when the access token has less than this left (5 min). */
const REFRESH_MARGIN_MS = 5 * 60 * 1000;
/** Default scopes: read/write + agent app actor (assignable + mentionable). */
const DEFAULT_SCOPES = "read,write,app:assignable,app:mentionable";

export interface LinearAvaOAuthConfig {
  clientId?: string;
  clientSecret?: string;
  redirectUri?: string;
  scopes?: string;
}

/** Persisted token state. `expiresAt` is epoch ms for the access token. */
export interface StoredTokens {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  /** Pending CSRF state during an in-flight authorize→callback dance. */
  pendingState?: string;
}

/** Linear's token endpoint response shape (the fields we use). */
interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
  token_type?: string;
  scope?: string;
}

/** Build the authorize URL for the actor=app dance. Pure — exported for tests. */
export function buildAuthorizeUrl(
  cfg: Required<Pick<LinearAvaOAuthConfig, "clientId" | "redirectUri">> & { scopes?: string },
  state: string,
): string {
  const params = new URLSearchParams({
    response_type: "code",
    client_id: cfg.clientId,
    redirect_uri: cfg.redirectUri,
    scope: cfg.scopes ?? DEFAULT_SCOPES,
    state,
    actor: "app",
    prompt: "consent",
  });
  return `${AUTHORIZE_URL}?${params.toString()}`;
}

/** Whether a stored access token needs refreshing (expired or within margin). */
export function needsRefresh(tokens: Pick<StoredTokens, "expiresAt">, now: number): boolean {
  return tokens.expiresAt - now <= REFRESH_MARGIN_MS;
}

export class LinearAvaTokenManager {
  private readonly filePath: string;
  private readonly cfg: LinearAvaOAuthConfig;
  private tokens: StoredTokens | null = null;
  /** Coalesces concurrent refreshes into one in-flight request. */
  private refreshing: Promise<string> | null = null;
  private readonly fetchImpl: typeof fetch;

  constructor(dataDir: string, cfg: LinearAvaOAuthConfig, fetchImpl: typeof fetch = fetch) {
    this.filePath = join(dataDir, "linear-ava-oauth.json");
    this.cfg = cfg;
    this.fetchImpl = fetchImpl;
    this._load();
  }

  /** Client creds + redirect are present — the dance can run. */
  isConfigured(): boolean {
    return Boolean(this.cfg.clientId && this.cfg.clientSecret && this.cfg.redirectUri);
  }

  /** A refresh token has been captured — Ava can mint access tokens. */
  isAuthorized(): boolean {
    return Boolean(this.tokens?.refreshToken);
  }

  /** Status for /api/linear/oauth/status — never leaks token material. */
  status(): { configured: boolean; authorized: boolean; expiresAt: number | null } {
    return {
      configured: this.isConfigured(),
      authorized: this.isAuthorized(),
      expiresAt: this.tokens?.expiresAt ?? null,
    };
  }

  /** Build the authorize URL + persist the CSRF state for callback validation. */
  startAuthorization(): string {
    if (!this.cfg.clientId || !this.cfg.redirectUri) {
      throw new Error("LINEAR_AVA_CLIENT_ID / LINEAR_AVA_REDIRECT_URI not configured");
    }
    const state = crypto.randomUUID();
    // Persist alongside tokens so the dance survives a restart between
    // authorize and callback.
    const base: StoredTokens = this.tokens ?? { accessToken: "", refreshToken: "", expiresAt: 0 };
    this.tokens = { ...base, pendingState: state };
    this._save();
    return buildAuthorizeUrl({ clientId: this.cfg.clientId, redirectUri: this.cfg.redirectUri, scopes: this.cfg.scopes }, state);
  }

  /**
   * Exchange an authorization code for tokens (the callback handler calls this).
   * Validates `state` against the persisted pending value (CSRF). Returns when
   * the refresh token is stored.
   */
  async handleCallback(code: string, state: string | null): Promise<void> {
    if (!this.cfg.clientId || !this.cfg.clientSecret || !this.cfg.redirectUri) {
      throw new Error("Linear Ava OAuth not configured");
    }
    const expected = this.tokens?.pendingState;
    if (expected && state !== expected) {
      throw new Error("OAuth state mismatch — possible CSRF, or a stale/duplicate callback");
    }
    const body = new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: this.cfg.redirectUri,
      client_id: this.cfg.clientId,
      client_secret: this.cfg.clientSecret,
    });
    const res = await this.fetchImpl(TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      throw new Error(`Linear token exchange failed: ${res.status} ${(await res.text()).slice(0, 300)}`);
    }
    const data = (await res.json()) as TokenResponse;
    if (!data.refresh_token) {
      throw new Error("Linear token exchange returned no refresh_token (is actor=app + a refresh-enabled app?)");
    }
    this._store(data);
  }

  /**
   * Return a valid access token, refreshing if expired/near-expiry. Throws if
   * not yet authorized. Concurrent callers share one in-flight refresh.
   */
  async getAccessToken(now: number = Date.now()): Promise<string> {
    if (!this.tokens?.refreshToken) {
      throw new Error("Linear Ava agent not authorized — run the /api/linear/oauth dance first");
    }
    if (this.tokens.accessToken && !needsRefresh(this.tokens, now)) {
      return this.tokens.accessToken;
    }
    if (!this.refreshing) {
      this.refreshing = this._refresh().finally(() => {
        this.refreshing = null;
      });
    }
    return this.refreshing;
  }

  private async _refresh(): Promise<string> {
    if (!this.cfg.clientId || !this.cfg.clientSecret || !this.tokens?.refreshToken) {
      throw new Error("Cannot refresh Linear Ava token — missing creds or refresh token");
    }
    const body = new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: this.tokens.refreshToken,
      client_id: this.cfg.clientId,
      client_secret: this.cfg.clientSecret,
    });
    const res = await this.fetchImpl(TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      throw new Error(`Linear token refresh failed: ${res.status} ${(await res.text()).slice(0, 300)}`);
    }
    const data = (await res.json()) as TokenResponse;
    this._store(data);
    return data.access_token;
  }

  /** Merge a token response into stored state (handles refresh-token rotation). */
  private _store(data: TokenResponse): void {
    const expiresInMs = (data.expires_in ?? 86399) * 1000;
    this.tokens = {
      accessToken: data.access_token,
      // Linear may rotate the refresh token; keep the prior one if absent.
      refreshToken: data.refresh_token ?? this.tokens?.refreshToken ?? "",
      expiresAt: Date.now() + expiresInMs,
      // Consume the pending CSRF state once the dance completes.
      pendingState: undefined,
    };
    this._save();
  }

  private _load(): void {
    try {
      if (existsSync(this.filePath)) {
        this.tokens = JSON.parse(readFileSync(this.filePath, "utf-8")) as StoredTokens;
      }
    } catch (err) {
      // Corrupt file shouldn't crash boot — surface loudly, start unauthorized.
      log.warn(`failed to load ${this.filePath}`, { err });
      this.tokens = null;
    }
  }

  private _save(): void {
    if (!this.tokens) return;
    const dir = dirname(this.filePath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(this.filePath, JSON.stringify(this.tokens, null, 2), { mode: 0o600 });
  }
}

// ── Singleton accessor ────────────────────────────────────────────────────────
// One manager per process so the OAuth routes (Piece A) and the agent-activity
// outbound (Piece B) share the same in-memory token + file.

let singleton: LinearAvaTokenManager | null = null;

export function getLinearAvaTokenManager(dataDir: string): LinearAvaTokenManager {
  if (!singleton) {
    singleton = new LinearAvaTokenManager(dataDir, {
      clientId: process.env.LINEAR_AVA_CLIENT_ID,
      clientSecret: process.env.LINEAR_AVA_CLIENT_SECRET,
      redirectUri: process.env.LINEAR_AVA_REDIRECT_URI,
      scopes: process.env.LINEAR_AVA_SCOPES,
    });
  }
  return singleton;
}

/** Test-only: reset the singleton between cases. */
export function resetLinearAvaTokenManagerForTesting(): void {
  singleton = null;
}
