import { describe, expect, test } from "bun:test";
import { extractDiscordFeedLinks, classifyFeedLink } from "../executors/deep-agent-executor.ts";

describe("classifyFeedLink", () => {
  test("buckets by host", () => {
    expect(classifyFeedLink("https://arxiv.org/abs/2604.1")).toBe("arxiv");
    expect(classifyFeedLink("https://huggingface.co/models")).toBe("huggingface");
    expect(classifyFeedLink("https://github.com/a/b")).toBe("github");
    expect(classifyFeedLink("https://youtu.be/x")).toBe("video");
    expect(classifyFeedLink("https://openai.com/blog")).toBe("web");
  });
});

describe("extractDiscordFeedLinks", () => {
  test("Components V2 (MonitoRSS): pulls the button url + text-display headline", () => {
    // Exact shape observed in the feed-ai-research channel.
    const msg = {
      content: "",
      embeds: [],
      author: { username: "MonitoRSS" },
      flags: 32768,
      components: [
        {
          type: 17,
          components: [
            { type: 10, content: "**Biodefense in the Intelligence Age**\nAn action plan for AI-powered biological resilience" },
            { type: 1, components: [{ type: 2, style: 5, label: "View", url: "https://openai.com/index/biodefense-in-the-intelligence-age" }] },
          ],
        },
      ],
    };
    const links = extractDiscordFeedLinks([msg]);
    expect(links).toHaveLength(1);
    expect(links[0]!.url).toBe("https://openai.com/index/biodefense-in-the-intelligence-age");
    expect(links[0]!.type).toBe("web");
    expect(links[0]!.from).toBe("MonitoRSS");
    expect(links[0]!.title).toContain("Biodefense in the Intelligence Age");
  });

  test("still handles classic content + embed urls (v1)", () => {
    const links = extractDiscordFeedLinks([
      { content: "check https://arxiv.org/abs/2604.9 and https://github.com/x/y", author: { username: "matt" } },
      { content: "", embeds: [{ url: "https://huggingface.co/m", title: "model" }], author: { username: "ava" } },
    ]);
    const urls = links.map((l) => l.url).sort();
    expect(urls).toEqual([
      "https://arxiv.org/abs/2604.9",
      "https://github.com/x/y",
      "https://huggingface.co/m",
    ]);
    expect(links.find((l) => l.url.includes("arxiv"))!.type).toBe("arxiv");
  });

  test("dedupes within a message + tolerates empty/missing", () => {
    expect(extractDiscordFeedLinks([])).toEqual([]);
    const links = extractDiscordFeedLinks([{ content: "https://a.com x https://a.com" }]);
    expect(links).toHaveLength(1);
  });
});
