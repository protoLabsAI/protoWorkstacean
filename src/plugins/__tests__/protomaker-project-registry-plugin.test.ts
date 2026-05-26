/**
 * ProtomakerProjectRegistryPlugin tests — covers the pure helpers
 * (git-config parsing) and the plugin's refresh + parity-check behavior
 * against a fake protoMaker HTTP server and a temporary workspace dir.
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
} from "../protomaker-project-registry-plugin.ts";

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
    // Fake protoMaker server returning settings.global with the fakeProjects list.
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

  function newPlugin(opts?: { parityCheck?: boolean; refreshIntervalMs?: number }): ProtomakerProjectRegistryPlugin {
    return new ProtomakerProjectRegistryPlugin({
      apiBase: `http://localhost:${server!.port}`,
      workspaceDir: tempDir,
      refreshIntervalMs: opts?.refreshIntervalMs ?? 50_000, // long, so test drives refreshes manually via setTimeout below
      parityCheck: opts?.parityCheck ?? false,
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

  test("fetches projects from protoMaker on install + populates registry", async () => {
    const projPath = join(tempDir, "myproj");
    makeGitRepo(projPath, "protoLabsAI/myproj", "main");
    fakeProjects.push({ id: "p1", name: "myproj", path: projPath });

    plugin = newPlugin();
    plugin.install(bus);

    // Initial fetch is async fire-and-forget — wait briefly for it.
    await new Promise((r) => setTimeout(r, 50));

    const projects = plugin.getProjects();
    expect(projects).toHaveLength(1);
    expect(projects[0]!.id).toBe("p1");
    expect(projects[0]!.name).toBe("myproj");
    expect(projects[0]!.path).toBe(projPath);
    expect(projects[0]!.github).toEqual({ owner: "protoLabsAI", repo: "myproj" });
    expect(projects[0]!.defaultBranch).toBe("main");
    expect(projects[0]!.source).toBe("protomaker");
    expect(fetchCount).toBe(1);
  });

  test("project without .git/ → registry entry has no github/defaultBranch", async () => {
    const projPath = join(tempDir, "no-git");
    mkdirSync(projPath, { recursive: true });
    fakeProjects.push({ id: "p2", name: "no-git", path: projPath });

    plugin = newPlugin();
    plugin.install(bus);
    await new Promise((r) => setTimeout(r, 50));

    const p = plugin.getProjects()[0]!;
    expect(p.github).toBeUndefined();
    expect(p.defaultBranch).toBeUndefined();
  });

  test("unreachable protoMaker server → plugin starts empty, lastError set", async () => {
    // Point at a port that's not listening — any free port other than the
    // test server's. Pick a high port and assume it's unused.
    plugin = new ProtomakerProjectRegistryPlugin({
      apiBase: "http://localhost:1", // port 1 is reserved + reliably refuses
      workspaceDir: tempDir,
      refreshIntervalMs: 50_000,
      parityCheck: false,
    });
    plugin.install(bus);
    await new Promise((r) => setTimeout(r, 100));

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
    plugin.install(bus);
    await new Promise((r) => setTimeout(r, 50));

    expect(plugin.getProjects()).toHaveLength(0);
    expect(plugin.getLastError()).toBeDefined();
    expect(plugin.getLastError()!).toContain("success=false");
  });

  test("parityCheck: logs nothing when no projects.yaml exists", async () => {
    // No projects.yaml in tempDir → parityCheck silently does nothing.
    const projPath = join(tempDir, "x");
    makeGitRepo(projPath, "foo/x", "main");
    fakeProjects.push({ id: "p1", name: "x", path: projPath });

    const warnLogs: string[] = [];
    const origWarn = console.warn;
    console.warn = (...args: unknown[]) => warnLogs.push(args.join(" "));

    plugin = newPlugin({ parityCheck: true });
    plugin.install(bus);
    await new Promise((r) => setTimeout(r, 50));

    console.warn = origWarn;
    const parityWarns = warnLogs.filter((l) => l.includes("parity"));
    expect(parityWarns).toHaveLength(0);
  });

  test("parityCheck: logs warning when project is only in protoMaker", async () => {
    const projPath = join(tempDir, "only-pm");
    makeGitRepo(projPath, "foo/only-pm", "main");
    fakeProjects.push({ id: "p1", name: "only-pm", path: projPath });

    // projects.yaml present but empty.
    writeFileSync(join(tempDir, "projects.yaml"), "projects: []\n");

    const warnLogs: string[] = [];
    const origWarn = console.warn;
    console.warn = (...args: unknown[]) => warnLogs.push(args.join(" "));

    plugin = newPlugin({ parityCheck: true });
    plugin.install(bus);
    await new Promise((r) => setTimeout(r, 50));

    console.warn = origWarn;
    const onlyPmWarn = warnLogs.find((l) => l.includes("only in protoMaker"));
    expect(onlyPmWarn).toBeDefined();
    expect(onlyPmWarn!).toContain("only-pm");
  });

  test("parityCheck: logs warning when project is only in yaml", async () => {
    // protoMaker returns nothing.
    writeFileSync(
      join(tempDir, "projects.yaml"),
      `projects:
  - slug: stale-project
    projectPath: /tmp/stale-project
    github: foo/stale
`,
    );

    const warnLogs: string[] = [];
    const origWarn = console.warn;
    console.warn = (...args: unknown[]) => warnLogs.push(args.join(" "));

    plugin = newPlugin({ parityCheck: true });
    plugin.install(bus);
    await new Promise((r) => setTimeout(r, 50));

    console.warn = origWarn;
    const onlyYamlWarn = warnLogs.find((l) => l.includes("only in projects.yaml"));
    expect(onlyYamlWarn).toBeDefined();
    expect(onlyYamlWarn!).toContain("stale-project");
  });

  test("parityCheck: logs warning on github mismatch for same path", async () => {
    const projPath = join(tempDir, "shared");
    makeGitRepo(projPath, "protoLabsAI/shared", "main"); // git config says protoLabsAI/shared

    fakeProjects.push({ id: "p1", name: "shared", path: projPath });

    // yaml says a different github coordinate.
    writeFileSync(
      join(tempDir, "projects.yaml"),
      `projects:
  - slug: shared
    projectPath: ${projPath}
    github: different-org/different-repo
`,
    );

    const warnLogs: string[] = [];
    const origWarn = console.warn;
    console.warn = (...args: unknown[]) => warnLogs.push(args.join(" "));

    plugin = newPlugin({ parityCheck: true });
    plugin.install(bus);
    await new Promise((r) => setTimeout(r, 50));

    console.warn = origWarn;
    const mismatchWarn = warnLogs.find((l) => l.includes("github mismatch"));
    expect(mismatchWarn).toBeDefined();
    expect(mismatchWarn!).toContain("protoLabsAI/shared");
    expect(mismatchWarn!).toContain("different-org/different-repo");
  });

  test("uninstall clears refresh timer + project list", async () => {
    const projPath = join(tempDir, "x");
    makeGitRepo(projPath, "foo/x", "main");
    fakeProjects.push({ id: "p1", name: "x", path: projPath });

    plugin = newPlugin();
    plugin.install(bus);
    await new Promise((r) => setTimeout(r, 50));
    expect(plugin.getProjects()).toHaveLength(1);

    plugin.uninstall();
    expect(plugin.getProjects()).toHaveLength(0);
    plugin = undefined; // prevent afterEach double-uninstall
  });
});
