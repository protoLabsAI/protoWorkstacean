/**
 * ProtomakerProjectRegistryPlugin tests — covers the pure helpers
 * (git-config parsing, slug derivation) and the plugin's refresh + accessor
 * behavior against a fake protoMaker HTTP server.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { InMemoryEventBus } from "../../../lib/bus.ts";
import {
  ProtomakerProjectRegistryPlugin,
  parseGithubFromGitConfig,
  parseDefaultBranchFromHead,
  deriveSlug,
} from "../protomaker-project-registry-plugin.ts";

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

describe("ProtomakerProjectRegistryPlugin", () => {
  let bus: InMemoryEventBus;
  let plugin: ProtomakerProjectRegistryPlugin | undefined;
  let tempDir: string;
  let server: ReturnType<typeof Bun.serve> | undefined;
  let fakeProjects: Array<{ id: string; name: string; path: string }>;
  let fetchCount: number;

  beforeEach(() => {
    bus = new InMemoryEventBus();
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
    plugin?.uninstall();
    server?.stop();
    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // best-effort
    }
  });

  function newPlugin(): ProtomakerProjectRegistryPlugin {
    return new ProtomakerProjectRegistryPlugin({
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

    plugin = newPlugin();
    await plugin.refreshNow();
    plugin.install(bus);

    const projects = plugin.getProjects();
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

    plugin = newPlugin();
    await plugin.refreshNow();

    const p = plugin.getProjects()[0]!;
    expect(p.github).toBeUndefined();
    expect(p.defaultBranch).toBeUndefined();
  });

  test("unreachable protoMaker server → plugin stays empty, lastError set", async () => {
    plugin = new ProtomakerProjectRegistryPlugin({
      apiBase: "http://localhost:1",
      refreshIntervalMs: 50_000,
    });
    await plugin.refreshNow();

    expect(plugin.getProjects()).toHaveLength(0);
    expect(plugin.getLastError()).toBeDefined();
  });

  test("server returns success=false → lastError surfaces it", async () => {
    server!.stop();
    server = Bun.serve({
      port: 0,
      fetch() {
        return Response.json({ success: false, error: "boom" });
      },
    });

    plugin = newPlugin();
    await plugin.refreshNow();

    expect(plugin.getProjects()).toHaveLength(0);
    expect(plugin.getLastError()).toBeDefined();
    expect(plugin.getLastError()!).toContain("success=false");
  });

  test("accessors: getBySlug / getByGithub / getByPath / getGithubCoords", async () => {
    const a = join(tempDir, "alpha");
    const b = join(tempDir, "beta");
    makeGitRepo(a, "org/alpha", "main");
    makeGitRepo(b, "org/beta", "dev");
    fakeProjects.push({ id: "a", name: "alpha", path: a });
    fakeProjects.push({ id: "b", name: "beta", path: b });

    plugin = newPlugin();
    await plugin.refreshNow();

    expect(plugin.getBySlug("alpha")?.id).toBe("a");
    expect(plugin.getBySlug("missing")).toBeUndefined();
    expect(plugin.getByGithub("org/beta")?.id).toBe("b");
    expect(plugin.getByGithub("missing/repo")).toBeUndefined();
    expect(plugin.getByPath(a)?.id).toBe("a");
    expect(plugin.getGithubCoords().sort()).toEqual(["org/alpha", "org/beta"]);
  });

  test("uninstall clears refresh timer + project list", async () => {
    const projPath = join(tempDir, "x");
    makeGitRepo(projPath, "foo/x", "main");
    fakeProjects.push({ id: "p1", name: "x", path: projPath });

    plugin = newPlugin();
    await plugin.refreshNow();
    plugin.install(bus);
    expect(plugin.getProjects()).toHaveLength(1);

    plugin.uninstall();
    expect(plugin.getProjects()).toHaveLength(0);
    plugin = undefined; // prevent afterEach double-uninstall
  });
});
