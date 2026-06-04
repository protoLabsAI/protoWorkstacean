import { describe, expect, test } from "bun:test";
import {
  isProductionLike,
  safeKeyEqual,
  isPublishTopicDenied,
  publishDenylistFromEnv,
  PUBLISH_TOPIC_DENYLIST_DEFAULT,
} from "../runtime-env.ts";

describe("isProductionLike", () => {
  test("true when NODE_ENV=production", () => {
    expect(isProductionLike({ NODE_ENV: "production" } as NodeJS.ProcessEnv)).toBe(true);
  });
  test("true when WORKSTACEAN_PUBLIC_BASE_URL is set", () => {
    expect(isProductionLike({ WORKSTACEAN_PUBLIC_BASE_URL: "https://x" } as NodeJS.ProcessEnv)).toBe(true);
  });
  test("false in a bare dev env", () => {
    expect(isProductionLike({} as NodeJS.ProcessEnv)).toBe(false);
  });
});

describe("safeKeyEqual", () => {
  test("true for equal non-empty strings", () => {
    expect(safeKeyEqual("secret-key", "secret-key")).toBe(true);
  });
  test("false for differing strings (incl. length mismatch)", () => {
    expect(safeKeyEqual("secret-key", "secret-keys")).toBe(false);
    expect(safeKeyEqual("a", "b")).toBe(false);
  });
  test("false for null/undefined/empty (no open on missing key)", () => {
    expect(safeKeyEqual(null, "x")).toBe(false);
    expect(safeKeyEqual("x", undefined)).toBe(false);
    expect(safeKeyEqual("", "")).toBe(false);
    expect(safeKeyEqual(undefined, undefined)).toBe(false);
  });
});

describe("isPublishTopicDenied", () => {
  test("blocks the internal control-plane topics", () => {
    for (const t of [
      "agent.skill.request",
      "agent.skill.response.abc",
      "operator.message.request",
      "message.inbound.discord.dm.123",
      "cron.tick",
      "ceremony.foo.execute",
      "command.agent.create",
      "autonomous.outcome.ava.chat",
      "agent.input.request.x",
      "dispatch.dropped.y",
    ]) {
      expect(isPublishTopicDenied(t), t).toBe(true);
    }
  });
  test("allows legitimate external lifecycle/event topics", () => {
    for (const t of [
      "feature.completed",
      "feature.blocked",
      "hitl.request.gate-hold",
      "release.published",
      "board.intake",
      "incident.reported",
    ]) {
      expect(isPublishTopicDenied(t), t).toBe(false);
    }
  });
  test("env override replaces the default denylist", () => {
    const dl = publishDenylistFromEnv({ WORKSTACEAN_PUBLISH_TOPIC_DENYLIST: "foo.,bar." } as NodeJS.ProcessEnv);
    expect(dl).toEqual(["foo.", "bar."]);
    expect(isPublishTopicDenied("foo.x", dl)).toBe(true);
    expect(isPublishTopicDenied("agent.skill.request", dl)).toBe(false); // not in override
  });
  test("default is used when override unset/blank", () => {
    expect(publishDenylistFromEnv({} as NodeJS.ProcessEnv)).toBe(PUBLISH_TOPIC_DENYLIST_DEFAULT);
  });
});
