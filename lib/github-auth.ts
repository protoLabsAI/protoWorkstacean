/**
 * GitHubAppAuth — shared GitHub App JWT + installation token helper.
 *
 * Used by GitHubPlugin (quinn[bot]) and OnboardingPlugin (webhook registration).
 * The A2A workspace plugin has its own inline copy for ava[bot] so workspace
 * plugins stay self-contained.
 *
 * Env vars:
 *   QUINN_APP_ID          GitHub App ID
 *   QUINN_APP_PRIVATE_KEY PEM private key (newlines as \n in env)
 *   GITHUB_TOKEN          PAT fallback when App credentials are absent
 */

import { createSign } from "node:crypto";

export class GitHubAppAuth {
  private cache = new Map<string, { token: string; exp: number }>();

  constructor(private appId: string, private privateKey: string) {}

  async getToken(owner: string, repo: string): Promise<string> {
    const key = `${owner}/${repo}`;
    const cached = this.cache.get(key);
    if (cached && cached.exp > Date.now() + 60_000) return cached.token;

    const jwt = this.makeJWT();
    const headers = this.appHeaders(jwt);

    const installResp = await fetch(
      `https://api.github.com/repos/${owner}/${repo}/installation`,
      { headers },
    );
    if (!installResp.ok) {
      throw new Error(`App not installed on ${owner}/${repo}: ${installResp.status}`);
    }
    const { id: installId } = await installResp.json() as { id: number };

    const tokenResp = await fetch(
      `https://api.github.com/app/installations/${installId}/access_tokens`,
      { method: "POST", headers },
    );
    if (!tokenResp.ok) {
      throw new Error(`Token fetch failed: ${tokenResp.status} ${await tokenResp.text()}`);
    }
    const { token, expires_at } = await tokenResp.json() as { token: string; expires_at: string };

    this.cache.set(key, { token, exp: new Date(expires_at).getTime() });
    return token;
  }

  private makeJWT(): string {
    const now = Math.floor(Date.now() / 1000);
    const header = Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT" })).toString("base64url");
    const payload = Buffer.from(
      JSON.stringify({ iat: now - 60, exp: now + 600, iss: this.appId }),
    ).toString("base64url");
    const data = `${header}.${payload}`;
    const sig = createSign("RSA-SHA256").update(data).sign(this.privateKey, "base64url");
    return `${data}.${sig}`;
  }

  private appHeaders(jwt: string): Record<string, string> {
    return {
      Authorization: `Bearer ${jwt}`,
      Accept: "application/vnd.github+json",
      "User-Agent": "protoWorkstacean/1.0",
      "X-GitHub-Api-Version": "2022-11-28",
    };
  }
}

/**
 * Returns a token getter for the Quinn GitHub App, or falls back to GITHUB_TOKEN PAT.
 * Returns null if no auth is configured.
 */
export function makeGitHubAuth(): ((owner: string, repo: string) => Promise<string>) | null {
  const appId = process.env.QUINN_APP_ID;
  const privateKey = process.env.QUINN_APP_PRIVATE_KEY;
  if (appId && privateKey) {
    const app = new GitHubAppAuth(appId, privateKey);
    return (owner, repo) => app.getToken(owner, repo);
  }
  const pat = process.env.GITHUB_TOKEN;
  if (pat) return () => Promise.resolve(pat);
  return null;
}
