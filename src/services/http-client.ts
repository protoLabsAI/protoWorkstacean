/**
 * Shared HTTP client — centralizes fetch(), error handling, timeouts,
 * auth headers, optional retry with exponential backoff, and envelope unwrapping.
 *
 * Usage:
 *   const client = new HttpClient({
 *     baseUrl: "https://api.github.com",
 *     timeoutMs: 15_000,
 *     auth: { type: "bearer", token },
 *   });
 *   const data = await client.get("/repos/foo/bar");
 *   const result = await client.post("/path", { key: "val" });
 *   const resp = await client.fetch("https://example.com/raw", { method: "GET" });
 */

export type AuthConfig =
  | { type: "bearer"; token: string }
  | { type: "api-key"; key: string }
  | { type: "basic"; credentials: string }
  | { type: "custom"; header: string; value: string };

export interface RetryConfig {
  attempts: number;
  baseDelayMs?: number;
}

export interface HttpClientOptions {
  /** Base URL prepended to all paths in get() and post(). Default: "". */
  baseUrl?: string;
  /** Default timeout in ms applied to every request. Default: 30_000. */
  timeoutMs?: number;
  /** Default headers merged into every request. */
  headers?: Record<string, string>;
  /** Auth applied to every request (can be overridden per-request). */
  auth?: AuthConfig;
  /** Optional retry policy for get() and post(). Default: no retry. */
  retry?: RetryConfig;
}

export interface RequestOptions {
  /** Per-request headers merged over client defaults (per-request wins). */
  headers?: Record<string, string>;
  /** Per-request timeout override. */
  timeoutMs?: number;
  /** Per-request auth override. */
  auth?: AuthConfig;
  /** Parse response body as plain text instead of JSON. Default: false. */
  responseType?: "json" | "text";
  /**
   * Unwrap standard API envelope: { success, data } → data.
   * Only applied when responseType is "json" (default). Default: false.
   */
  unwrapEnvelope?: boolean;
}

function applyAuth(headers: Record<string, string>, auth: AuthConfig): void {
  switch (auth.type) {
    case "bearer":
      headers["Authorization"] = `Bearer ${auth.token}`;
      break;
    case "api-key":
      headers["X-API-Key"] = auth.key;
      break;
    case "basic":
      headers["Authorization"] = `Basic ${auth.credentials}`;
      break;
    case "custom":
      headers[auth.header] = auth.value;
      break;
  }
}

export class HttpClient {
  private readonly baseUrl: string;
  private readonly defaultTimeoutMs: number;
  private readonly defaultHeaders: Record<string, string>;
  private readonly defaultAuth: AuthConfig | undefined;
  private readonly retry: RetryConfig | undefined;

  constructor(opts: HttpClientOptions = {}) {
    this.baseUrl = opts.baseUrl ?? "";
    this.defaultTimeoutMs = opts.timeoutMs ?? 30_000;
    this.defaultHeaders = opts.headers ?? {};
    this.defaultAuth = opts.auth;
    this.retry = opts.retry;
  }

  /**
   * Low-level fetch — merges client default headers with per-request headers
   * (per-request wins) and applies the configured timeout.
   *
   * Returns the raw Response for callers that need custom response handling
   * (e.g. special HTTP status codes, text bodies, non-standard error shapes).
   */
  async fetch(url: string, init: RequestInit & { timeoutMs?: number } = {}): Promise<Response> {
    const { timeoutMs, headers: initHeaders, ...rest } = init;

    const merged: Record<string, string> = { ...this.defaultHeaders };
    if (this.defaultAuth) applyAuth(merged, this.defaultAuth);
    if (initHeaders) {
      const extra = initHeaders instanceof Headers
        ? Object.fromEntries(initHeaders.entries())
        : (initHeaders as Record<string, string>);
      Object.assign(merged, extra);
    }

    return fetch(url, {
      ...rest,
      headers: merged,
      signal: AbortSignal.timeout(timeoutMs ?? this.defaultTimeoutMs),
    });
  }

  /**
   * GET request — throws on non-2xx.
   * Returns parsed JSON (or plain text if responseType: "text").
   */
  async get(url: string, opts: RequestOptions = {}): Promise<unknown> {
    return this._request("GET", this.baseUrl + url, undefined, opts);
  }

  /**
   * POST request — serializes body as JSON, throws on non-2xx.
   * Returns parsed JSON (or plain text if responseType: "text").
   */
  async post(url: string, body: unknown, opts: RequestOptions = {}): Promise<unknown> {
    return this._request("POST", this.baseUrl + url, body, opts);
  }

  private async _request(
    method: string,
    url: string,
    body: unknown,
    opts: RequestOptions,
  ): Promise<unknown> {
    const timeoutMs = opts.timeoutMs ?? this.defaultTimeoutMs;
    const auth = opts.auth ?? this.defaultAuth;

    const headers: Record<string, string> = { ...this.defaultHeaders };
    if (body !== undefined) headers["Content-Type"] = "application/json";
    if (auth) applyAuth(headers, auth);
    if (opts.headers) Object.assign(headers, opts.headers);

    const doFetch = async (): Promise<unknown> => {
      const resp = await fetch(url, {
        method,
        headers,
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(timeoutMs),
      });

      if (!resp.ok) {
        const errText = await resp.text().catch(() => "");
        throw new Error(`HTTP ${resp.status} ${errText}`);
      }

      if (opts.responseType === "text") {
        return resp.text();
      }

      const json = await resp.json();

      if (
        opts.unwrapEnvelope &&
        json !== null &&
        typeof json === "object" &&
        "data" in json &&
        "success" in json
      ) {
        return (json as { data: unknown }).data;
      }

      return json;
    };

    if (!this.retry) return doFetch();

    let lastErr: unknown;
    for (let i = 0; i < this.retry.attempts; i++) {
      try {
        return await doFetch();
      } catch (err) {
        lastErr = err;
        if (i < this.retry.attempts - 1) {
          const delay = (this.retry.baseDelayMs ?? 100) * Math.pow(2, i);
          await new Promise<void>(r => setTimeout(r, delay));
        }
      }
    }
    throw lastErr;
  }
}
