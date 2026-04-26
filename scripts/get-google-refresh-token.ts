#!/usr/bin/env bun
/**
 * One-shot helper to mint a Google OAuth2 refresh token for the Workspace
 * plugin. Run on a desktop with a browser available; copy the printed
 * refresh token into Infisical as `GOOGLE_REFRESH_TOKEN`.
 *
 * Usage:
 *   GOOGLE_CLIENT_ID=... GOOGLE_CLIENT_SECRET=... bun run scripts/get-google-refresh-token.ts
 *
 * Or with infisical:
 *   infisical run --env=prod -- bun run scripts/get-google-refresh-token.ts
 *   (the infisical secrets are named GOOGLE_WORKSPACE_CLIENT_ID/_SECRET, so
 *   prefix the command with the alias mappings:)
 *   infisical run --env=prod -- sh -c 'GOOGLE_CLIENT_ID=$GOOGLE_WORKSPACE_CLIENT_ID GOOGLE_CLIENT_SECRET=$GOOGLE_WORKSPACE_CLIENT_SECRET bun run scripts/get-google-refresh-token.ts'
 *
 * The flow:
 *   1. Reads GOOGLE_CLIENT_ID + GOOGLE_CLIENT_SECRET from env.
 *   2. Spins up a one-shot HTTP server on http://127.0.0.1:8765.
 *   3. Builds the consent URL with all 4 service scopes (Drive, Docs,
 *      Calendar, Gmail) and prompts you to open it.
 *   4. After you approve, Google redirects to the local server with a
 *      `?code=…`. The script swaps it for an access + refresh token.
 *   5. Prints the refresh token + a one-liner to push it to Infisical.
 *      The script does NOT push it for you — too easy to log into the
 *      wrong workspace by accident.
 *
 * Notes:
 *   - The OAuth client in Google Cloud Console must list
 *     `http://127.0.0.1:8765/oauth2/callback` as an Authorized redirect URI.
 *   - The script grants scopes for ALL four services. Trim if you want a
 *     narrower token.
 *   - Refresh tokens are long-lived but can be revoked; running this script
 *     again rotates the token (per-user, per-client).
 */

const REDIRECT_URI = "http://127.0.0.1:8765/oauth2/callback";
const PORT = 8765;

/** Scope set covering the GooglePlugin's modules (Drive, Docs, Calendar, Gmail). */
const SCOPES = [
  "https://www.googleapis.com/auth/drive",
  "https://www.googleapis.com/auth/documents",
  "https://www.googleapis.com/auth/calendar",
  "https://www.googleapis.com/auth/gmail.modify",
  // Required for offline access + refresh-token issuance.
  "openid",
  "https://www.googleapis.com/auth/userinfo.email",
];

function main(): void {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    console.error(
      "GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET must be set in the environment.\n" +
      "If your Infisical secrets are named GOOGLE_WORKSPACE_CLIENT_ID/_SECRET, " +
      "alias them at the shell:\n" +
      "  infisical run --env=prod -- sh -c 'GOOGLE_CLIENT_ID=$GOOGLE_WORKSPACE_CLIENT_ID GOOGLE_CLIENT_SECRET=$GOOGLE_WORKSPACE_CLIENT_SECRET bun run scripts/get-google-refresh-token.ts'",
    );
    process.exit(1);
  }

  const authUrl =
    "https://accounts.google.com/o/oauth2/v2/auth?" +
    new URLSearchParams({
      client_id: clientId,
      redirect_uri: REDIRECT_URI,
      response_type: "code",
      scope: SCOPES.join(" "),
      access_type: "offline",
      // `prompt=consent` forces Google to issue a fresh refresh token rather
      // than relying on a previously-issued one (which the script can't see).
      prompt: "consent",
      include_granted_scopes: "true",
    }).toString();

  console.log("\n┌─ Google OAuth2 — refresh token helper ────────────────────────────────┐");
  console.log("│  1. Open this URL in your browser and approve access:                  │");
  console.log("└────────────────────────────────────────────────────────────────────────┘\n");
  console.log(authUrl + "\n");

  const server = Bun.serve({
    port: PORT,
    hostname: "127.0.0.1",
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname !== "/oauth2/callback") {
        return new Response("Not found", { status: 404 });
      }
      const code = url.searchParams.get("code");
      const error = url.searchParams.get("error");
      if (error) {
        const html = `<h2>OAuth error: ${error}</h2><p>You can close this tab.</p>`;
        setTimeout(() => { server.stop(true); process.exit(2); }, 100);
        return new Response(html, { status: 400, headers: { "content-type": "text/html" } });
      }
      if (!code) {
        return new Response("Missing ?code", { status: 400 });
      }

      try {
        const tokenResp = await fetch("https://oauth2.googleapis.com/token", {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({
            code,
            client_id: clientId,
            client_secret: clientSecret,
            redirect_uri: REDIRECT_URI,
            grant_type: "authorization_code",
          }),
        });
        const tokens = (await tokenResp.json()) as {
          access_token?: string;
          refresh_token?: string;
          scope?: string;
          expires_in?: number;
          error?: string;
          error_description?: string;
        };
        if (tokens.error || !tokens.refresh_token) {
          const msg = tokens.error_description ?? tokens.error ?? "no refresh_token in response";
          console.error(`\n❌ Token exchange failed: ${msg}`);
          console.error("Full response:", tokens);
          setTimeout(() => { server.stop(true); process.exit(3); }, 100);
          return new Response(`<h2>Token exchange failed</h2><pre>${msg}</pre>`, {
            status: 500, headers: { "content-type": "text/html" },
          });
        }

        // Print to stderr (the URL was on stdout in some terminals; keep
        // sensitive output on a separate stream so a redirect-to-file pipe
        // doesn't capture the secret).
        process.stderr.write("\n✅ Refresh token captured.\n\n");
        process.stderr.write("──── REFRESH TOKEN (do not commit) ────────────────────────\n");
        process.stderr.write(tokens.refresh_token + "\n");
        process.stderr.write("───────────────────────────────────────────────────────────\n\n");
        process.stderr.write("Push to Infisical (workstacean prod env):\n\n");
        process.stderr.write(
          `  infisical secrets set GOOGLE_REFRESH_TOKEN='${tokens.refresh_token}' --env=prod\n\n`,
        );
        process.stderr.write(`Granted scopes: ${tokens.scope ?? "(unknown)"}\n`);
        process.stderr.write(`Access token (short-lived, ${tokens.expires_in ?? "?"}s): ${tokens.access_token?.slice(0, 16)}…\n\n`);

        setTimeout(() => { server.stop(true); process.exit(0); }, 200);
        return new Response(
          "<h2>✅ Refresh token captured</h2><p>You can close this tab. Check the terminal for the token + Infisical command.</p>",
          { status: 200, headers: { "content-type": "text/html" } },
        );
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`\n❌ Network error during token exchange: ${msg}`);
        setTimeout(() => { server.stop(true); process.exit(4); }, 100);
        return new Response(`<h2>Network error</h2><pre>${msg}</pre>`, {
          status: 500, headers: { "content-type": "text/html" },
        });
      }
    },
  });

  console.log(`Listening on ${REDIRECT_URI} for the redirect…`);
  console.log("(Make sure this exact URI is on the Authorized redirect URIs list of your Google OAuth client.)\n");
}

main();
