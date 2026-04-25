import { describe, test, expect } from "bun:test";
import { validateProjectEntry } from "../lib/project-schema.ts";

const minimalValid = {
  slug: "my-project",
  github: "owner/repo",
  status: "active",
  discord: { dev: "123456789" },
};

describe("validateProjectEntry — valid entries", () => {
  test("minimal valid entry (only required fields)", () => {
    const result = validateProjectEntry(minimalValid);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.entry.slug).toBe("my-project");
      expect(result.entry.github).toBe("owner/repo");
      expect(result.entry.status).toBe("active");
      expect(result.entry.discord.dev).toBe("123456789");
    }
  });

  test("full entry with all optional fields populated", () => {
    const full = {
      ...minimalValid,
      title: "My Project",
      defaultBranch: "main",
      team: "platform",
      agents: ["quinn", "onboarding"],
      discord: {
        dev: "123456789",
        general: "111",
        updates: "222",
        alerts: "333",
        releases: "444",
      },
      onboardedAt: "2025-01-01T00:00:00Z",
      onboardingState: {
        githubWebhook: "ok" as const,
        projectsYaml: "ok" as const,
      },
    };
    const result = validateProjectEntry(full);
    expect(result.ok).toBe(true);
  });

  test("entry with googleWorkspace fields", () => {
    const entry = {
      ...minimalValid,
      googleWorkspace: {
        driveFolderId: "folder-xyz",
        sharedDocId: "doc-abc",
        calendarId: "cal-123",
      },
    };
    const result = validateProjectEntry(entry);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.entry.googleWorkspace?.driveFolderId).toBe("folder-xyz");
    }
  });
});

describe("validateProjectEntry — invalid entries", () => {
  test("missing slug", () => {
    const { slug: _, ...entry } = minimalValid;
    const result = validateProjectEntry(entry);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some(e => e.includes("slug"))).toBe(true);
    }
  });

  test("missing github repo", () => {
    const { github: _, ...entry } = minimalValid;
    const result = validateProjectEntry(entry);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some(e => e.includes("github"))).toBe(true);
    }
  });

  test("missing status", () => {
    const { status: _, ...entry } = minimalValid;
    const result = validateProjectEntry(entry);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some(e => e.includes("status"))).toBe(true);
    }
  });

  test("missing discord.dev channel", () => {
    const entry = { ...minimalValid, discord: { general: "111" } };
    const result = validateProjectEntry(entry);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some(e => e.includes("dev"))).toBe(true);
    }
  });

  test("invalid status value — empty string fails min(1)", () => {
    const entry = { ...minimalValid, status: "" };
    const result = validateProjectEntry(entry);
    expect(result.ok).toBe(false);
  });
});

describe("validateProjectEntry — validation on load (a2a + OnboardingPlugin pattern)", () => {
  test("a2a skips invalid entries and keeps valid ones", () => {
    // Simulates the loop in buildIndex() in lib/plugins/a2a.ts
    const rawProjects: unknown[] = [
      minimalValid,
      { slug: "bad-entry" /* missing github, status, discord */ },
      { ...minimalValid, slug: "second-project" },
    ];

    let called = 0;
    const valid: string[] = [];
    const skipped: string[] = [];

    for (const raw of rawProjects) {
      called++;
      const result = validateProjectEntry(raw);
      if (result.ok) {
        valid.push(result.entry.slug);
      } else {
        const slug = (raw as Record<string, unknown>)?.slug as string ?? "(unknown)";
        skipped.push(slug);
      }
    }

    expect(called).toBe(3);
    expect(valid).toContain("my-project");
    expect(valid).toContain("second-project");
    expect(skipped).toContain("bad-entry");
  });

  test("OnboardingPlugin write pattern — valid entry passes through unchanged", () => {
    // Simulates the write validation in lib/plugins/onboarding.ts
    const entry = { ...minimalValid };
    const result = validateProjectEntry(entry);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.entry.slug).toBe(entry.slug);
    }
  });

  test("OnboardingPlugin write pattern — invalid entry is caught before write", () => {
    // Missing discord.dev would be caught before writing to projects.yaml
    const entry = { slug: "test", github: "owner/repo", status: "active", discord: {} };
    const result = validateProjectEntry(entry);
    expect(result.ok).toBe(false);
  });
});

describe("validateProjectEntry — safe to re-run", () => {
  test("validating an already-valid entry returns the same shape unchanged", () => {
    const result1 = validateProjectEntry(minimalValid);
    expect(result1.ok).toBe(true);
    if (!result1.ok) return;

    const result2 = validateProjectEntry(result1.entry);
    expect(result2.ok).toBe(true);
    if (!result2.ok) return;

    expect(result2.entry).toEqual(result1.entry);
  });
});
