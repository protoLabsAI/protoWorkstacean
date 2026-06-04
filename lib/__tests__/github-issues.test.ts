import { describe, expect, test } from "bun:test";
import { closeIssue } from "../github-issues.ts";

/** A fetch stub recording calls and returning canned responses. */
function stubFetch(responses: Array<{ ok: boolean; status?: number; text?: string }>) {
  const calls: Array<{ url: string; method?: string; body?: unknown }> = [];
  let i = 0;
  const fetchImpl = (async (url: string, init?: { method?: string; body?: string }) => {
    calls.push({ url, method: init?.method, body: init?.body ? JSON.parse(init.body) : undefined });
    const r = responses[i++] ?? { ok: true, status: 200 };
    return { ok: r.ok, status: r.status ?? (r.ok ? 200 : 500), text: async () => r.text ?? "" } as Response;
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

const auth = async () => "tok";

describe("closeIssue", () => {
  test("comments then PATCHes the issue closed with state_reason=completed", async () => {
    const { fetchImpl, calls } = stubFetch([{ ok: true }, { ok: true }]);
    await closeIssue("o", "r", 7, { comment: "shipped", authGetter: auth, fetchImpl });
    expect(calls).toHaveLength(2);
    expect(calls[0].url).toBe("https://api.github.com/repos/o/r/issues/7/comments");
    expect(calls[0].body).toEqual({ body: "shipped" });
    expect(calls[1].url).toBe("https://api.github.com/repos/o/r/issues/7");
    expect(calls[1].method).toBe("PATCH");
    expect(calls[1].body).toEqual({ state: "closed", state_reason: "completed" });
  });

  test("skips the comment call when no comment is given", async () => {
    const { fetchImpl, calls } = stubFetch([{ ok: true }]);
    await closeIssue("o", "r", 8, { authGetter: auth, fetchImpl });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://api.github.com/repos/o/r/issues/8");
  });

  test("honors reason=not_planned", async () => {
    const { fetchImpl, calls } = stubFetch([{ ok: true }]);
    await closeIssue("o", "r", 9, { reason: "not_planned", authGetter: auth, fetchImpl });
    expect(calls[0].body).toEqual({ state: "closed", state_reason: "not_planned" });
  });

  test("a failed comment is non-fatal — the close still happens", async () => {
    const { fetchImpl, calls } = stubFetch([{ ok: false, status: 403 }, { ok: true }]);
    await closeIssue("o", "r", 10, { comment: "x", authGetter: auth, fetchImpl });
    expect(calls).toHaveLength(2);
    expect(calls[1].method).toBe("PATCH");
  });

  test("throws (fail-loud) when the PATCH fails", async () => {
    const { fetchImpl } = stubFetch([{ ok: false, status: 422, text: "nope" }]);
    await expect(closeIssue("o", "r", 11, { authGetter: auth, fetchImpl })).rejects.toThrow(/422/);
  });
});
