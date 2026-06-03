import { describe, test, expect, beforeEach } from "bun:test";
import { alreadyHandled, _resetDedup } from "../dedup.ts";

beforeEach(() => _resetDedup());

describe("alreadyHandled", () => {
  test("first sight is new, repeat within TTL is a duplicate", () => {
    expect(alreadyHandled("msg:1")).toBe(false);
    expect(alreadyHandled("msg:1")).toBe(true);
    expect(alreadyHandled("msg:1")).toBe(true);
  });

  test("distinct keys are independent", () => {
    expect(alreadyHandled("msg:a")).toBe(false);
    expect(alreadyHandled("msg:b")).toBe(false);
    expect(alreadyHandled("msg:a")).toBe(true);
    expect(alreadyHandled("react:1:u:📋")).toBe(false);
    expect(alreadyHandled("react:1:u:📋")).toBe(true);
  });
});
