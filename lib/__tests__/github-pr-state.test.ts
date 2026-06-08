/**
 * fetchPrState — null-on-failure contract. A network error or malformed body
 * must return null (not throw), because feature-remediation's escalation path
 * relies on null meaning "unknown" rather than crashing.
 */
import { describe, expect, test } from "bun:test";
import { fetchPrState } from "../github-pr-state.ts";

const auth = async () => "fake-token";
const ok = (body: unknown) =>
  (async () => new Response(JSON.stringify(body), { status: 200 })) as unknown as typeof fetch;

describe("fetchPrState — null on failure", () => {
  test("happy path → PrState", async () => {
    const r = await fetchPrState("o", "r", 1, { authGetter: auth, fetchImpl: ok({ state: "closed", merged: true }) });
    expect(r).toEqual({ number: 1, state: "closed", merged: true });
  });

  test("fetch throws (network error) → null", async () => {
    const fetchImpl = (async () => { throw new Error("ECONNREFUSED"); }) as unknown as typeof fetch;
    expect(await fetchPrState("o", "r", 1, { authGetter: auth, fetchImpl })).toBeNull();
  });

  test("malformed body (json throws) → null", async () => {
    const fetchImpl = (async () => new Response("<!DOCTYPE html>not json", { status: 200 })) as unknown as typeof fetch;
    expect(await fetchPrState("o", "r", 1, { authGetter: auth, fetchImpl })).toBeNull();
  });

  test("non-ok response → null", async () => {
    const fetchImpl = (async () => new Response("nope", { status: 503 })) as unknown as typeof fetch;
    expect(await fetchPrState("o", "r", 1, { authGetter: auth, fetchImpl })).toBeNull();
  });

  test("auth throws → null", async () => {
    const authGetter = async () => { throw new Error("no token"); };
    expect(await fetchPrState("o", "r", 1, { authGetter, fetchImpl: ok({}) })).toBeNull();
  });
});
