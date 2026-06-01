/**
 * WorkspaceWatcher — the shared poll-based file/dir diff primitive (ADR-0004 P1).
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  WorkspaceWatcher,
  diffSnapshots,
  snapshotPaths,
  YAML_FILTER,
  type FileDiff,
} from "../workspace-watcher.ts";

describe("workspace-watcher", () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "ww-")); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  test("diffSnapshots classifies added / changed / removed", () => {
    const prev = new Map([["a", "1:10"], ["b", "1:20"]]);
    const next = new Map([["a", "1:10"], ["b", "2:25"], ["c", "1:5"]]);
    expect(diffSnapshots(prev, next)).toEqual({ added: ["c"], changed: ["b"], removed: [] });
    expect(diffSnapshots(next, prev)).toEqual({ added: [], changed: ["b"], removed: ["c"] });
  });

  test("YAML_FILTER takes .yaml/.yml, rejects .example + non-yaml", () => {
    expect(YAML_FILTER("ava.yaml")).toBe(true);
    expect(YAML_FILTER("ava.yml")).toBe(true);
    expect(YAML_FILTER("ava.yaml.example")).toBe(false);
    expect(YAML_FILTER("README.md")).toBe(false);
  });

  test("snapshotPaths ignores .example templates + honors the filter", () => {
    writeFileSync(join(dir, "real.yaml"), "name: real\n");
    writeFileSync(join(dir, "tmpl.yaml.example"), "name: tmpl\n");
    const snap = snapshotPaths([dir], [], YAML_FILTER);
    expect(snap.size).toBe(1);
    expect([...snap.keys()][0]).toBe(join(dir, "real.yaml"));
  });

  test("poll() reports add → change → remove against a primed baseline, and stays quiet when nothing changes", () => {
    writeFileSync(join(dir, "ava.yaml"), "name: ava\n");
    const diffs: FileDiff[] = [];
    const w = new WorkspaceWatcher({ dirs: [dir], onChange: (d) => diffs.push(d) });
    w.prime(); // existing ava.yaml is the baseline — not reported as "added"

    writeFileSync(join(dir, "quinn.yaml"), "name: quinn\n");
    w.poll();
    expect(diffs.at(-1)).toMatchObject({ added: [join(dir, "quinn.yaml")], changed: [], removed: [] });

    writeFileSync(join(dir, "ava.yaml"), "name: ava\nrole: general\n"); // size differs → changed
    w.poll();
    expect(diffs.at(-1)!.changed).toContain(join(dir, "ava.yaml"));

    unlinkSync(join(dir, "quinn.yaml"));
    w.poll();
    expect(diffs.at(-1)!.removed).toContain(join(dir, "quinn.yaml"));

    const seen = diffs.length;
    w.poll(); // no change since last poll
    expect(diffs.length).toBe(seen);
  });
});
