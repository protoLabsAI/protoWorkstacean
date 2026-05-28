import { describe, expect, test } from "bun:test";
import { parseReleasePublished } from "../github.ts";

// A trimmed GitHub `release` webhook payload (action=published).
function releasePayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    action: "published",
    release: {
      tag_name: "v1.4.0",
      name: "v1.4.0 — Spring cleanup",
      body: "## What changed\n- thing one\n- thing two",
      html_url: "https://github.com/protoLabsAI/widget/releases/tag/v1.4.0",
      draft: false,
      prerelease: false,
      published_at: "2026-05-27T12:00:00Z",
      author: { login: "mabry1985" },
    },
    repository: { name: "widget", owner: { login: "protoLabsAI" } },
    ...overrides,
  };
}

describe("parseReleasePublished", () => {
  test("normalizes a published release into a ReleasePublishedPayload", () => {
    const out = parseReleasePublished(releasePayload());
    expect(out).toEqual({
      owner: "protoLabsAI",
      repo: "widget",
      version: "v1.4.0",
      name: "v1.4.0 — Spring cleanup",
      body: "## What changed\n- thing one\n- thing two",
      url: "https://github.com/protoLabsAI/widget/releases/tag/v1.4.0",
      author: "mabry1985",
      prerelease: false,
      publishedAt: "2026-05-27T12:00:00Z",
    });
  });

  test("ignores non-published actions (created / edited / deleted)", () => {
    for (const action of ["created", "edited", "deleted", "prereleased", "released"]) {
      expect(parseReleasePublished(releasePayload({ action }))).toBeNull();
    }
  });

  test("returns null when the tag, repo, or owner is missing (no silent partial event)", () => {
    expect(parseReleasePublished(releasePayload({ release: { tag_name: "" } }))).toBeNull();
    expect(parseReleasePublished(releasePayload({ repository: { owner: { login: "x" } } }))).toBeNull();
    expect(parseReleasePublished(releasePayload({ repository: { name: "widget" } }))).toBeNull();
    expect(parseReleasePublished({ action: "published" })).toBeNull();
  });

  test("falls back name→version and tolerates null body/url", () => {
    const out = parseReleasePublished(
      releasePayload({
        release: { tag_name: "v2.0.0", name: null, body: null, html_url: "", prerelease: true, author: null },
      }),
    );
    expect(out?.name).toBe("v2.0.0");
    expect(out?.body).toBe("");
    expect(out?.author).toBe("");
    expect(out?.prerelease).toBe(true);
    expect(typeof out?.publishedAt).toBe("string"); // fallback timestamp
  });
});
