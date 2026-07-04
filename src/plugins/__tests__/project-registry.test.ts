/**
 * ProjectRegistry tests — pure helpers (git-config parsing, slug derivation,
 * slug de-dup) plus the registry's refresh + accessor behavior against a fake
 * protoMaker HTTP server.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  ProjectRegistry,
  type RegistryProject,
  dedupeBySlug,
  parseGithubFromGitConfig,
  parseDefaultBranchFromHead,
  deriveSlug,
} from "../project-registry.ts";

describe("deriveSlug", () => {
  test("lowercases and dashes non-alphanum", () => {
    expect(deriveSlug("protoMaker")).toBe("protomaker");
    expect(deriveSlug("rabbit-hole.io")).toBe("rabbit-hole-io");
    expect(deriveSlug("escape from qud")).toBe("escape-from-qud");
  });

  test("trims leading/trailing dashes", () => {
    expect(deriveSlug(".myproject.")).toBe("myproject");
  });
});

describe("dedupeBySlug", () => {
  test("keeps the first occurrence and drops later slug collisions", () => {
    const projects: RegistryProject[] = [
      { id: "1", name: "Proto Maker", slug: "proto-maker", path: "/a" },
      { id: "2", name: "proto.maker", slug: "proto-maker", path: "/b" },
      { id: "3", name: "other", slug: "other", path: "/c" },
    ];
    const out = dedupeBySlug(projects);
    expect(out.map((p) => p.id)).toEqual(["1", "3"]);
  });
});

describe("parseGithubFromGitConfig", () => {
  test("SSH origin url → owner/repo", () => {
    const config = `[remote "origin"]
\turl = git@github.com:protoLabsAI/protoWorkstacean.git
\tfetch = +refs/heads/*:refs/remotes/origin/*`;
    expect(parseGithubFromGitConfig(config)).toEqual({
      owner: "protoLabsAI",
      repo: "protoWorkstacean",
    });
  });

  test("HTTPS origin url → owner/repo", () => {
    const config = `[remote "origin"]
\turl = https://github.com/protoLabsAI/protoMaker.git`;
    expect(parseGithubFromGitConfig(config)).toEqual({
      owner: "protoLabsAI",
      repo: "protoMaker",
    });
  });

  test("url without .git suffix", () => {
    const config = `[remote "origin"]\n\turl = git@github.com:foo/bar`;
    expect(parseGithubFromGitConfig(config)).toEqual({ owner: "foo", repo: "bar" });
  });

  test("non-origin remote is ignored", () => {
    const config = `[remote "upstream"]
\turl = git@github.com:upstream-org/upstream-repo.git
[remote "origin"]
\turl = git@github.com:my-fork/my-repo.git`;
    expect(parseGithubFromGitConfig(config)).toEqual({
      owner: "my-fork",
      repo: "my-repo",
    });
  });

  test("no GitHub origin → undefined", () => {
    const config = `[remote "origin"]\n\turl = https://gitlab.com/foo/bar.git`;
    expect(parseGithubFromGitConfig(config)).toBeUndefined();
  });

  test("no origin section → undefined", () => {
    const config = `[core]\n\trepositoryformatversion = 0`;
    expect(parseGithubFromGitConfig(config)).toBeUndefined();
  });
});

describe("parseDefaultBranchFromHead", () => {
  test("standard symref → branch name", () => {
    expect(parseDefaultBranchFromHead("ref: refs/remotes/origin/main")).toBe("main");
  });

  test("trailing newline", () => {
    expect(parseDefaultBranchFromHead("ref: refs/remotes/origin/dev\n")).toBe("dev");
  });

  test("non-symref content → undefined", () => {
    expect(parseDefaultBranchFromHead("garbage")).toBeUndefined();
  });
});

describe("ProjectRegistry", () => {
  let registry: ProjectRegistry | undefined;
  let tempDir: string;
  let server: ReturnType<typeof Bun.serve> | undefined;
  let fakeProjects: Array<{ id: string; name: string; path: string; github?: { owner: string; repo: string }; defaultBranch?: string }>;
  let fetchCount: number;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "wsk-pm-registry-test-"));
    fakeProjects = [];
    fetchCount = 0;
    server = Bun.serve({
      port: 0,
      fetch(req) {
        const url = new URL(req.url);
        if (url.pathname === "/api/settings/global") {
          fetchCount++;
          return Response.json({ success: true, settings: { projects: fakeProjects } });
        }
        return new Response("not found", { status: 404 });
      },
    });
  });

  afterEach(() => {
    registry?.stop();
    server?.stop();
    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // best-effort
    }
  });

  function newRegistry(): ProjectRegistry {
    return new ProjectRegistry({
      apiBase: `http://localhost:${server!.port}`,
      refreshIntervalMs: 50_000,
    });
  }

  function makeGitRepo(path: string, github: string, defaultBranch: string): void {
    mkdirSync(join(path, ".git", "refs", "remotes", "origin"), { recursive: true });
    writeFileSync(
      join(path, ".git", "config"),
      `[remote "origin"]\n\turl = git@github.com:${github}.git\n`,
    );
    writeFileSync(
      join(path, ".git", "refs", "remotes", "origin", "HEAD"),
      `ref: refs/remotes/origin/${defaultBranch}\n`,
    );
  }

  test("refreshNow populates registry with derived slug + git enrichment", async () => {
    const projPath = join(tempDir, "myproj");
    makeGitRepo(projPath, "protoLabsAI/myProject", "main");
    fakeProjects.push({ id: "p1", name: "myProject", path: projPath });

    registry = newRegistry();
    await registry.refreshNow();
    registry.start();

    const projects = registry.getProjects();
    expect(projects).toHaveLength(1);
    expect(projects[0]!.id).toBe("p1");
    expect(projects[0]!.name).toBe("myProject");
    expect(projects[0]!.slug).toBe("myproject");
    expect(projects[0]!.path).toBe(projPath);
    expect(projects[0]!.github).toEqual({ owner: "protoLabsAI", repo: "myProject" });
    expect(projects[0]!.defaultBranch).toBe("main");
    expect(fetchCount).toBe(1);
  });

  test("project without .git/ → registry entry has no github/defaultBranch", async () => {
    const projPath = join(tempDir, "no-git");
    mkdirSync(projPath, { recursive: true });
    fakeProjects.push({ id: "p2", name: "no-git", path: projPath });

    registry = newRegistry();
    await registry.refreshNow();

    const p = registry.getProjects()[0]!;
    expect(p.github).toBeUndefined();
    expect(p.defaultBranch).toBeUndefined();
  });

  test("prefers protoMaker's native github/defaultBranch over .git derivation (rename-safe)", async () => {
    // The clone's remote still says the OLD repo name (contentMachine), but
    // protoMaker carries the renamed truth (protoContent). Native field wins.
    const projPath = join(tempDir, "contentmachine");
    makeGitRepo(projPath, "protoLabsAI/contentMachine", "master");
    fakeProjects.push({
      id: "p3",
      name: "contentMachine",
      path: projPath,
      github: { owner: "protoLabsAI", repo: "protoContent" },
      defaultBranch: "main",
    });

    registry = newRegistry();
    await registry.refreshNow();

    const p = registry.getProjects()[0]!;
    expect(p.github).toEqual({ owner: "protoLabsAI", repo: "protoContent" });
    expect(p.defaultBranch).toBe("main");
    // getByGithub resolves on the live name, not the stale derived one.
    expect(registry.getByGithub("protoLabsAI/protoContent")?.slug).toBe("contentmachine");
    expect(registry.getByGithub("protoLabsAI/contentMachine")).toBeUndefined();
  });

  test("falls back to .git derivation when protoMaker omits github/defaultBranch", async () => {
    const projPath = join(tempDir, "legacy");
    makeGitRepo(projPath, "protoLabsAI/legacyRepo", "main");
    fakeProjects.push({ id: "p4", name: "legacyRepo", path: projPath }); // no native fields

    registry = newRegistry();
    await registry.refreshNow();

    const p = registry.getProjects()[0]!;
    expect(p.github).toEqual({ owner: "protoLabsAI", repo: "legacyRepo" });
    expect(p.defaultBranch).toBe("main");
  });

  test("unreachable protoMaker server → registry stays empty, lastError set", async () => {
    registry = new ProjectRegistry({
      apiBase: "http://localhost:1",
      refreshIntervalMs: 50_000,
    });
    await registry.refreshNow();

    expect(registry.getProjects()).toHaveLength(0);
    expect(registry.getLastError()).toBeDefined();
  });

  test("server returns success=false → lastError surfaces it", async () => {
    server!.stop();
    server = Bun.serve({
      port: 0,
      fetch() {
        return Response.json({ success: false, error: "boom" });
      },
    });

    registry = newRegistry();
    await registry.refreshNow();

    expect(registry.getProjects()).toHaveLength(0);
    expect(registry.getLastError()).toBeDefined();
    expect(registry.getLastError()!).toContain("success=false");
  });

  test("accessors: getBySlug / getByGithub (case-insensitive) / getByPath / getGithubCoords", async () => {
    const a = join(tempDir, "alpha");
    const b = join(tempDir, "beta");
    makeGitRepo(a, "org/alpha", "main");
    makeGitRepo(b, "org/Beta", "dev");
    fakeProjects.push({ id: "a", name: "alpha", path: a });
    fakeProjects.push({ id: "b", name: "beta", path: b });

    registry = newRegistry();
    await registry.refreshNow();

    expect(registry.getBySlug("alpha")?.id).toBe("a");
    expect(registry.getBySlug("missing")).toBeUndefined();
    expect(registry.getByGithub("org/beta")?.id).toBe("b"); // git config says org/Beta
    expect(registry.getByGithub("ORG/ALPHA")?.id).toBe("a"); // case-insensitive
    expect(registry.getByGithub("missing/repo")).toBeUndefined();
    expect(registry.getByPath(a)?.id).toBe("a");
    expect(registry.getGithubCoords().sort()).toEqual(["org/Beta", "org/alpha"]);
  });

  test("non-OK response → lastError surfaces the status, projects stay empty", async () => {
    // Point the registry at a path the stub server 404s.
    registry = new ProjectRegistry({
      apiBase: `http://localhost:${server!.port}/wrong`,
      refreshIntervalMs: 50_000,
    });
    await registry.refreshNow();

    expect(registry.getProjects()).toHaveLength(0);
    expect(registry.getLastError()).toContain("HTTP 404");
  });

  test("duplicate derived slug → first wins, second dropped", async () => {
    const a = join(tempDir, "a");
    const b = join(tempDir, "b");
    makeGitRepo(a, "org/proto-maker", "main");
    makeGitRepo(b, "org/proto-maker2", "main");
    // Two distinct protoMaker names that normalize to the same slug.
    fakeProjects.push({ id: "a", name: "Proto Maker", path: a });
    fakeProjects.push({ id: "b", name: "proto.maker", path: b });

    registry = newRegistry();
    await registry.refreshNow();

    const matches = registry.getProjects().filter((p) => p.slug === "proto-maker");
    expect(matches).toHaveLength(1);
    expect(matches[0]!.id).toBe("a");
  });

  test("stop() clears refresh timer + project list", async () => {
    const projPath = join(tempDir, "x");
    makeGitRepo(projPath, "foo/x", "main");
    fakeProjects.push({ id: "p1", name: "x", path: projPath });

    registry = newRegistry();
    await registry.refreshNow();
    registry.start();
    expect(registry.getProjects()).toHaveLength(1);

    registry.stop();
    expect(registry.getProjects()).toHaveLength(0);
    registry = undefined; // prevent afterEach double-stop
  });
});
