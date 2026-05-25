import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { isAgentBotActor } from "../github.ts";

describe("isAgentBotActor", () => {
  const ENV_KEY = "WORKSTACEAN_AGENT_BOT_LOGINS";
  let snapshot: string | undefined;

  beforeEach(() => {
    snapshot = process.env[ENV_KEY];
    delete process.env[ENV_KEY];
  });

  afterEach(() => {
    if (snapshot === undefined) delete process.env[ENV_KEY];
    else process.env[ENV_KEY] = snapshot;
  });

  test("matches the default protoLabs agent bots (both bare + [bot]-suffixed)", () => {
    expect(isAgentBotActor("protoquinn")).toBe(true);
    expect(isAgentBotActor("protoquinn[bot]")).toBe(true);
    expect(isAgentBotActor("ava")).toBe(true);
    expect(isAgentBotActor("ava[bot]")).toBe(true);
    expect(isAgentBotActor("protobot")).toBe(true);
    expect(isAgentBotActor("protobot[bot]")).toBe(true);
  });

  test("does NOT match human authors or unrelated bots", () => {
    expect(isAgentBotActor("mabry1985")).toBe(false);
    expect(isAgentBotActor("dependabot[bot]")).toBe(false);
    expect(isAgentBotActor("coderabbitai[bot]")).toBe(false);
    expect(isAgentBotActor("github-actions[bot]")).toBe(false);
  });

  test("treats undefined / null / empty as not-a-bot (defensive)", () => {
    expect(isAgentBotActor(undefined)).toBe(false);
    expect(isAgentBotActor(null)).toBe(false);
    expect(isAgentBotActor("")).toBe(false);
  });

  test("comparison is case-insensitive (GitHub login casing is inconsistent across payload paths)", () => {
    expect(isAgentBotActor("ProToQuiNN[Bot]")).toBe(true);
    expect(isAgentBotActor("AVA")).toBe(true);
  });

  test("WORKSTACEAN_AGENT_BOT_LOGINS env override replaces the default set entirely", () => {
    process.env[ENV_KEY] = "custom-bot,another-bot[bot]";
    expect(isAgentBotActor("custom-bot")).toBe(true);
    expect(isAgentBotActor("another-bot[bot]")).toBe(true);
    // Defaults are NOT merged in — protoquinn is no longer in the set
    expect(isAgentBotActor("protoquinn")).toBe(false);
    expect(isAgentBotActor("ava[bot]")).toBe(false);
  });

  test("env override strips whitespace and ignores empty entries", () => {
    process.env[ENV_KEY] = "  foo  ,, bar[bot]  ,";
    expect(isAgentBotActor("foo")).toBe(true);
    expect(isAgentBotActor("bar[bot]")).toBe(true);
    expect(isAgentBotActor("")).toBe(false);
  });
});
