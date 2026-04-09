import { describe, test, expect, beforeEach } from "bun:test";
import { SkillResolver } from "../skill-resolver.ts";
import type { AgentDefinition } from "../../agent-runtime/types.ts";

// ── Helpers ───────────────────────────────────────────────────────────────────

const makeAgentDef = (
  name: string,
  skills: Array<{ name: string; keywords?: string[] }>,
): AgentDefinition => ({
  name,
  role: "general",
  model: "claude-sonnet-4-6",
  systemPrompt: "test",
  tools: [],
  maxTurns: 10,
  skills: skills.map(s => ({ name: s.name, keywords: s.keywords })),
});

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("SkillResolver", () => {
  let resolver: SkillResolver;

  beforeEach(() => {
    resolver = new SkillResolver();
    resolver.loadFromAgents([
      makeAgentDef("quinn", [
        { name: "bug_triage", keywords: ["bug", "broken", "crash", "error"] },
        { name: "pr_review",  keywords: ["pr", "pull request", "review"] },
      ]),
      makeAgentDef("ava", [
        { name: "sitrep", keywords: ["status", "sitrep", "/sitrep"] },
        { name: "plan",   keywords: ["plan", "/plan"] },
      ]),
    ]);
  });

  describe("explicit skillHint (priority 1)", () => {
    test("returns the hint as skill with via=hint", () => {
      const match = resolver.resolve("bug_triage", "something random");
      expect(match).not.toBeNull();
      expect(match!.skill).toBe("bug_triage");
      expect(match!.via).toBe("hint");
    });

    test("hint takes priority over matching keywords", () => {
      // Content matches sitrep but hint is bug_triage
      const match = resolver.resolve("bug_triage", "give me a status report");
      expect(match!.skill).toBe("bug_triage");
      expect(match!.via).toBe("hint");
    });

    test("trims whitespace from hint", () => {
      const match = resolver.resolve("  sitrep  ", undefined);
      expect(match!.skill).toBe("sitrep");
      expect(match!.via).toBe("hint");
    });
  });

  describe("keyword matching (priority 2)", () => {
    test("matches a keyword in content", () => {
      const match = resolver.resolve(undefined, "there's a bug in the login flow");
      expect(match).not.toBeNull();
      expect(match!.skill).toBe("bug_triage");
      expect(match!.via).toBe("keyword");
      expect(match!.agentName).toBe("quinn");
    });

    test("case-insensitive match", () => {
      const match = resolver.resolve(undefined, "There is an ERROR in production");
      expect(match!.skill).toBe("bug_triage");
    });

    test("matches multi-word keyword", () => {
      const match = resolver.resolve(undefined, "please do a pull request review");
      expect(match!.skill).toBe("pr_review");
    });

    test("matches /command-style keywords", () => {
      const match = resolver.resolve(undefined, "/sitrep");
      expect(match!.skill).toBe("sitrep");
    });

    test("returns first match when multiple keywords match", () => {
      // "bug" and "status" both match — bug_triage is registered first
      const match = resolver.resolve(undefined, "bug status check");
      expect(match!.skill).toBe("bug_triage");
    });
  });

  describe("default skill (priority 3)", () => {
    test("returns default when nothing matches", () => {
      const r = new SkillResolver("sitrep");
      r.loadFromAgents([makeAgentDef("quinn", [{ name: "bug_triage", keywords: ["bug"] }])]);
      const match = r.resolve(undefined, "what is the weather today?");
      expect(match).not.toBeNull();
      expect(match!.skill).toBe("sitrep");
      expect(match!.via).toBe("default");
    });

    test("returns null when no default and nothing matches", () => {
      const match = resolver.resolve(undefined, "completely unrelated content xyz");
      expect(match).toBeNull();
    });

    test("returns null when hint is empty string", () => {
      const match = resolver.resolve("", "no keyword match here xyz");
      expect(match).toBeNull();
    });
  });

  describe("loadFromAgents", () => {
    test("ignores skills without keywords", () => {
      const r = new SkillResolver();
      r.loadFromAgents([
        makeAgentDef("ava", [
          { name: "plan_resume" }, // no keywords
          { name: "plan", keywords: ["/plan"] },
        ]),
      ]);
      expect(r.size).toBe(1);
      expect(r.resolve(undefined, "/plan")!.skill).toBe("plan");
      expect(r.resolve(undefined, "plan_resume")).toBeNull();
    });

    test("reloading replaces previous entries", () => {
      resolver.loadFromAgents([
        makeAgentDef("frank", [{ name: "ci_debug", keywords: ["ci", "pipeline"] }]),
      ]);
      // Previous quinn/ava entries gone
      expect(resolver.resolve(undefined, "there is a bug")).toBeNull();
      expect(resolver.resolve(undefined, "ci failed")!.skill).toBe("ci_debug");
    });

    test("size reflects keyword-bearing skills only", () => {
      const r = new SkillResolver();
      r.loadFromAgents([
        makeAgentDef("a", [
          { name: "s1", keywords: ["k1"] },
          { name: "s2" }, // no keywords
          { name: "s3", keywords: ["k3", "k4"] },
        ]),
      ]);
      expect(r.size).toBe(2);
    });
  });
});
