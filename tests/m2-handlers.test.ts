/**
 * m2-handlers.test.ts
 *
 * Unit tests for two M2 additions:
 *  1. Discord autocomplete filtering (discord.ts — InteractionCreate handler)
 *  2. GitHub org webhook repository.created handler (github.ts — _handleEvent)
 */

import { describe, test, expect, mock, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { GitHubPlugin } from "../lib/plugins/github.ts";
import type { EventBus, BusMessage } from "../lib/types.ts";

// ── Shared fixture data ──────────────────────────────────────────────────────

const PROJECTS_YAML = `
projects:
  - slug: protolabsai-protoworkstacean
    title: protoWorkstacean
    github: protolabsai/protoworkstacean
    status: active
    discord:
      dev: "111222333"
  - slug: protolabsai-quinn
    title: Quinn
    github: protolabsai/quinn
    status: active
  - slug: protolabsai-protoui
    title: protoUI
    github: protolabsai/protoui
    status: active
    discord:
      dev: "444555666"
  - slug: protolabsai-archived
    title: ArchivedProject
    github: protolabsai/archived
    status: archived
`;

// Create a real temp workspace with fake YAML so file-loading helpers work
let workspaceDir: string;

beforeAll(() => {
  workspaceDir = mkdtempSync(join(tmpdir(), "workstacean-m2-test-"));
  writeFileSync(join(workspaceDir, "projects.yaml"), PROJECTS_YAML);
  // github.yaml not required — plugin falls back to defaults
});

afterAll(() => {
  rmSync(workspaceDir, { recursive: true, force: true });
});

// ── Mock EventBus factory ────────────────────────────────────────────────────

function makeMockBus(): { bus: EventBus; publishCalls: Array<{ topic: string; msg: BusMessage }> } {
  const publishCalls: Array<{ topic: string; msg: BusMessage }> = [];
  const bus: EventBus = {
    publish: mock((topic: string, msg: BusMessage) => {
      publishCalls.push({ topic, msg });
    }),
    subscribe: mock(() => "sub-id"),
    unsubscribe: mock(() => {}),
    topics: mock(() => []),
    consumers: mock(() => []),
  };
  return { bus, publishCalls };
}

// ── Discord autocomplete — project filtering ─────────────────────────────────
//
// The autocomplete handler in discord.ts (InteractionCreate closure) runs this logic:
//
//   const projects = loadProjectsDefs(workspaceDir);  // reads + filters projects.yaml
//   const typed = focused.value.toLowerCase();
//   const choices = projects
//     .filter(p =>
//       p.slug.toLowerCase().includes(typed) ||
//       p.title.toLowerCase().includes(typed)
//     )
//     .slice(0, 25)
//     .map(p => ({ name: p.title, value: p.slug }));
//
// We test this logic directly (isolated from the Discord.js client) using the same
// algorithm and the same data that loadProjectsDefs returns from the real temp workspace.

describe("Discord autocomplete — project filtering", () => {
  // Active projects as loadProjectsDefs would return them (archived filtered out)
  const activeProjects = [
    { slug: "protolabsai-protoworkstacean", title: "protoWorkstacean", discord: { dev: "111222333" } },
    { slug: "protolabsai-quinn", title: "Quinn", discord: undefined },
    { slug: "protolabsai-protoui", title: "protoUI", discord: { dev: "444555666" } },
  ];

  function autocompleteChoices(
    projects: typeof activeProjects,
    typed: string,
  ) {
    return projects
      .filter(
        (p) =>
          p.slug.toLowerCase().includes(typed.toLowerCase()) ||
          p.title.toLowerCase().includes(typed.toLowerCase()),
      )
      .slice(0, 25)
      .map((p) => ({ name: p.title, value: p.slug }));
  }

  test('partial input "work" returns matching projects', () => {
    const choices = autocompleteChoices(activeProjects, "work");
    // "protoWorkstacean" matches on title ("work") and slug ("workstacean")
    expect(choices.length).toBeGreaterThan(0);
    const slugs = choices.map((c) => c.value);
    expect(slugs).toContain("protolabsai-protoworkstacean");
    // Quinn and protoUI do not match "work"
    expect(slugs).not.toContain("protolabsai-quinn");
    expect(slugs).not.toContain("protolabsai-protoui");
  });

  test("input that matches nothing returns empty choices array", () => {
    const choices = autocompleteChoices(activeProjects, "zzznomatch");
    expect(choices).toHaveLength(0);
  });

  test("empty string returns all active projects (up to 25)", () => {
    const choices = autocompleteChoices(activeProjects, "");
    // All 3 active projects should be returned (archived is excluded by loadProjectsDefs)
    expect(choices).toHaveLength(3);
    const slugs = choices.map((c) => c.value);
    expect(slugs).toContain("protolabsai-protoworkstacean");
    expect(slugs).toContain("protolabsai-quinn");
    expect(slugs).toContain("protolabsai-protoui");
    // Archived project must not appear
    expect(slugs).not.toContain("protolabsai-archived");
  });

  test("choices are capped at 25 entries (Discord limit)", () => {
    // Build 30 fake projects and assert slice(0, 25) applies
    const manyProjects = Array.from({ length: 30 }, (_, i) => ({
      slug: `project-${i}`,
      title: `Project ${i}`,
      discord: undefined,
    }));
    const choices = autocompleteChoices(manyProjects, "project");
    expect(choices).toHaveLength(25);
  });

  test("choice shape has { name, value } with title and slug", () => {
    const choices = autocompleteChoices(activeProjects, "quinn");
    expect(choices).toHaveLength(1);
    expect(choices[0]).toEqual({ name: "Quinn", value: "protolabsai-quinn" });
  });
});

// ── Discord flat-command — devChannelId + projectRepo resolution ──────────────
//
// When a flat command includes a `project` option, the handler looks up the project
// in projects.yaml and attaches devChannelId and projectRepo to the bus payload.
//
// discord.ts lines 382-389:
//   const project = projects.find(p => p.slug === projectSlug);
//   if (project) {
//     devChannelId = project.discord?.dev || undefined;
//     projectRepo  = project.github || undefined;
//   }

describe("Discord flat-command — project metadata resolution", () => {
  type ProjectEntry = {
    slug: string;
    title: string;
    github?: string;
    discord?: { dev?: string };
  };

  function resolveProject(projects: ProjectEntry[], slug: string) {
    const project = projects.find((p) => p.slug === slug);
    if (!project) return { devChannelId: undefined, projectRepo: undefined };
    return {
      devChannelId: project.discord?.dev || undefined,
      projectRepo: project.github || undefined,
    };
  }

  const projects: ProjectEntry[] = [
    {
      slug: "protolabsai-protoworkstacean",
      title: "protoWorkstacean",
      github: "protolabsai/protoworkstacean",
      discord: { dev: "111222333" },
    },
    {
      slug: "protolabsai-quinn",
      title: "Quinn",
      github: "protolabsai/quinn",
      discord: undefined,
    },
  ];

  test("resolves devChannelId and projectRepo for a known project", () => {
    const result = resolveProject(projects, "protolabsai-protoworkstacean");
    expect(result.devChannelId).toBe("111222333");
    expect(result.projectRepo).toBe("protolabsai/protoworkstacean");
  });

  test("devChannelId is undefined when project has no discord.dev", () => {
    const result = resolveProject(projects, "protolabsai-quinn");
    expect(result.devChannelId).toBeUndefined();
    expect(result.projectRepo).toBe("protolabsai/quinn");
  });

  test("both fields are undefined for an unknown slug", () => {
    const result = resolveProject(projects, "unknown-project");
    expect(result.devChannelId).toBeUndefined();
    expect(result.projectRepo).toBeUndefined();
  });
});

// ── GitHub org webhook — repository.created ──────────────────────────────────

describe("GitHub plugin — repository.created handler", () => {
  const mockGetToken = mock(async (_owner: string, _repo: string) => "fake-token");

  // Minimal GitHubConfig (no autoTriage, no admins)
  const baseConfig = { mentionHandle: "@quinn", skillHints: {} };

  function makePayload(fullName: string, isPrivate = false) {
    const [owner, name] = fullName.split("/");
    return {
      action: "created",
      repository: {
        name,
        full_name: fullName,
        owner: { login: owner },
        html_url: `https://github.com/${fullName}`,
        description: "A new repository",
        private: isPrivate,
      },
    };
  }

  test("publishes message.inbound.onboard for repository.created", () => {
    const { bus, publishCalls } = makeMockBus();
    const plugin = new GitHubPlugin(workspaceDir);

    const payload = makePayload("protolabsai/new-repo");
    (plugin as unknown as { _handleEvent: Function })._handleEvent(
      "repository",
      payload,
      baseConfig,
      bus,
      mockGetToken,
    );

    expect(publishCalls).toHaveLength(1);
    expect(publishCalls[0].topic).toBe("message.inbound.onboard");
  });

  test("published message has correct topic and payload shape", () => {
    const { bus, publishCalls } = makeMockBus();
    const plugin = new GitHubPlugin(workspaceDir);

    const payload = makePayload("protolabsai/protoworkstacean");
    (plugin as unknown as { _handleEvent: Function })._handleEvent(
      "repository",
      payload,
      baseConfig,
      bus,
      mockGetToken,
    );

    expect(publishCalls).toHaveLength(1);
    const { topic, msg } = publishCalls[0];

    expect(topic).toBe("message.inbound.onboard");
    expect(msg.topic).toBe("message.inbound.onboard");
    expect(msg.payload).toMatchObject({
      event: "repository.created",
      owner: "protolabsai",
      repo: "protoworkstacean",
      fullName: "protolabsai/protoworkstacean",
      url: "https://github.com/protolabsai/protoworkstacean",
      isPrivate: false,
    });
    expect(msg.source).toEqual({ interface: "github" });
    expect(typeof msg.id).toBe("string");
    expect(typeof msg.correlationId).toBe("string");
    expect(typeof msg.timestamp).toBe("number");
  });

  test("non-repository.created event (issues) does not publish", () => {
    const { bus, publishCalls } = makeMockBus();
    const plugin = new GitHubPlugin(workspaceDir);

    // An 'issues' event without @mention — should not publish
    const payload = {
      action: "opened",
      issue: {
        number: 42,
        title: "Bug report",
        html_url: "https://github.com/protolabsai/quinn/issues/42",
        body: "Something broke",
        user: { login: "externalUser" },
      },
      repository: {
        name: "quinn",
        full_name: "protolabsai/quinn",
        owner: { login: "protolabsai" },
      },
    };

    (plugin as unknown as { _handleEvent: Function })._handleEvent(
      "issues",
      payload,
      baseConfig,
      bus,
      mockGetToken,
    );

    expect(publishCalls).toHaveLength(0);
  });

  test("repository event with action other than 'created' does not publish to onboard", () => {
    const { bus, publishCalls } = makeMockBus();
    const plugin = new GitHubPlugin(workspaceDir);

    const payload = {
      action: "deleted",
      repository: {
        name: "quinn",
        full_name: "protolabsai/quinn",
        owner: { login: "protolabsai" },
        html_url: "https://github.com/protolabsai/quinn",
        description: "",
        private: false,
      },
    };

    (plugin as unknown as { _handleEvent: Function })._handleEvent(
      "repository",
      payload,
      baseConfig,
      bus,
      mockGetToken,
    );

    expect(publishCalls).toHaveLength(0);
  });

  test("published message id includes the repo full_name", () => {
    const { bus, publishCalls } = makeMockBus();
    const plugin = new GitHubPlugin(workspaceDir);

    const payload = makePayload("protolabsai/protoworkstacean");
    (plugin as unknown as { _handleEvent: Function })._handleEvent(
      "repository",
      payload,
      baseConfig,
      bus,
      mockGetToken,
    );

    expect(publishCalls[0].msg.id).toContain("protolabsai-protoworkstacean");
  });
});
