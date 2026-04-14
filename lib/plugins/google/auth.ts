/**
 * Google OAuth2 token management — shared across all Google service modules.
 * Exports getGoogleAccessToken() and createTokenRefresher().
 */

import type { EventBus } from "../../types.ts";

interface TokenState {
  accessToken: string;
  expiresAt: number; // ms since epoch
}

// Module-level token cache — shared across all imports of this module.
let _tokenState: TokenState | null = null;

/**
 * Returns a valid Google access token, refreshing if needed.
 * Returns null if credentials are not configured or refresh fails.
 */
export async function getGoogleAccessToken(): Promise<string | null> {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  const refreshToken = process.env.GOOGLE_REFRESH_TOKEN;

  if (!clientId || !clientSecret || !refreshToken) return null;

  // Return cached token if still valid (with 5-minute buffer)
  if (_tokenState && Date.now() < _tokenState.expiresAt - 300_000) {
    return _tokenState.accessToken;
  }

  return _doTokenRefresh(clientId, clientSecret, refreshToken);
}

async function _doTokenRefresh(
  clientId: string,
  clientSecret: string,
  refreshToken: string,
): Promise<string | null> {
  const params = new URLSearchParams({
    grant_type: "refresh_token",
    client_id: clientId,
    client_secret: clientSecret,
    refresh_token: refreshToken,
  });

  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const resp = await fetch("https://oauth2.googleapis.com/token", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: params.toString(),
        signal: AbortSignal.timeout(15_000),
      });

      if (!resp.ok) {
        const errBody = await resp.text().catch(() => "");
        console.error(`[google] Token refresh failed (attempt ${attempt}): ${resp.status} ${errBody}`);
        if (attempt < 3) await _sleep(1_000 * attempt);
        continue;
      }

      const data = await resp.json() as { access_token: string; expires_in: number };
      _tokenState = {
        accessToken: data.access_token,
        expiresAt: Date.now() + data.expires_in * 1_000,
      };
      console.log(`[google] Access token refreshed (expires in ${data.expires_in}s)`);
      return _tokenState.accessToken;
    } catch (err) {
      console.error(`[google] Token refresh error (attempt ${attempt}):`, err);
      if (attempt < 3) await _sleep(1_000 * attempt);
    }
  }
  return null;
}

export interface TokenRefresher {
  start(): void;
  stop(): void;
}

/**
 * Creates a background job that proactively refreshes the token before expiry.
 * Publishes auth.token_refresh_failed to the bus if refresh fails.
 */
export function createTokenRefresher(bus: EventBus): TokenRefresher {
  let timer: ReturnType<typeof setInterval> | null = null;

  return {
    start() {
      // Check every 60 minutes; refresh proactively when within 10 minutes of expiry.
      timer = setInterval(async () => {
        if (!_tokenState) return;

        const timeToExpiry = _tokenState.expiresAt - Date.now();
        if (timeToExpiry < 10 * 60_000) {
          console.log("[google] Access token nearing expiry — refreshing proactively");
          const newToken = await getGoogleAccessToken();
          if (!newToken) {
            console.error("[google] Proactive token refresh failed — publishing auth.token_refresh_failed");
            bus.publish("auth.token_refresh_failed", {
              id: crypto.randomUUID(),
              correlationId: crypto.randomUUID(),
              topic: "auth.token_refresh_failed",
              timestamp: Date.now(),
              payload: { plugin: "google", reason: "Token refresh failed after 3 retries" },
            });
          }
        }
      }, 60 * 60_000);
    },

    stop() {
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
    },
  };
}

function _sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
