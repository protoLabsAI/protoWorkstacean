/**
 * WorkspaceWatcher — a small, reusable poll-based file/dir watcher that emits
 * structured {added, changed, removed} diffs.
 *
 * The fleet has several config surfaces that hot-reload by polling a directory
 * (ceremonies, channels) — each grew its own ad-hoc snapshot loop. This is the
 * shared primitive (ADR-0004): give it directories and/or individual files, a
 * filter, and an interval; it snapshots (mtime+size per file) and calls
 * onChange with the diff whenever something changes.
 *
 * Poll-based (not fs.watch) on purpose: works uniformly across bind-mounts and
 * container filesystems where inotify is unreliable, and `poll()` is directly
 * unit-testable without real timers.
 */

import { readdirSync, statSync, existsSync } from "node:fs";
import { join } from "node:path";

export interface FileDiff {
  added: string[];
  changed: string[];
  removed: string[];
}

/** path → "mtimeMs:size" signature. */
export type FileSnapshot = Map<string, string>;

/** Default: YAML files, excluding `*.example` templates. */
export const YAML_FILTER = (f: string): boolean =>
  (f.endsWith(".yaml") || f.endsWith(".yml")) && !f.endsWith(".example");

export function snapshotPaths(
  dirs: string[],
  files: string[],
  filter: (f: string) => boolean,
): FileSnapshot {
  const snap: FileSnapshot = new Map();
  for (const dir of dirs) {
    if (!existsSync(dir)) continue;
    let entries: string[];
    try {
      entries = readdirSync(dir).filter(filter);
    } catch {
      continue; // dir vanished mid-scan
    }
    for (const name of entries) {
      const p = join(dir, name);
      try {
        const s = statSync(p);
        snap.set(p, `${s.mtimeMs}:${s.size}`);
      } catch {
        // transient (file removed between readdir and stat) — skip
      }
    }
  }
  for (const f of files) {
    if (!existsSync(f)) continue;
    try {
      const s = statSync(f);
      snap.set(f, `${s.mtimeMs}:${s.size}`);
    } catch {
      // transient — skip
    }
  }
  return snap;
}

export function diffSnapshots(prev: FileSnapshot, next: FileSnapshot): FileDiff {
  const added: string[] = [];
  const changed: string[] = [];
  const removed: string[] = [];
  for (const [p, sig] of next) {
    const old = prev.get(p);
    if (old === undefined) added.push(p);
    else if (old !== sig) changed.push(p);
  }
  for (const p of prev.keys()) {
    if (!next.has(p)) removed.push(p);
  }
  return { added, changed, removed };
}

export function isEmptyDiff(d: FileDiff): boolean {
  return d.added.length === 0 && d.changed.length === 0 && d.removed.length === 0;
}

export interface WorkspaceWatcherOptions {
  /** Directories scanned (non-recursive) for files matching `filter`. */
  dirs?: string[];
  /** Individual files to watch (filter not applied to these). */
  files?: string[];
  /** Dir-entry filter. Default: YAML, excluding `*.example`. */
  filter?: (filename: string) => boolean;
  /** Poll interval in ms. Default 5000. */
  intervalMs?: number;
  /** Called with the diff whenever a poll detects changes. */
  onChange: (diff: FileDiff) => void;
}

export class WorkspaceWatcher {
  private readonly dirs: string[];
  private readonly files: string[];
  private readonly filter: (f: string) => boolean;
  private readonly intervalMs: number;
  private readonly onChange: (diff: FileDiff) => void;
  private snapshot: FileSnapshot = new Map();
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(opts: WorkspaceWatcherOptions) {
    this.dirs = opts.dirs ?? [];
    this.files = opts.files ?? [];
    this.filter = opts.filter ?? YAML_FILTER;
    this.intervalMs = opts.intervalMs ?? 5000;
    this.onChange = opts.onChange;
  }

  /** Snapshot current state WITHOUT firing onChange — call after the initial load so existing files aren't reported as "added". */
  prime(): void {
    this.snapshot = snapshotPaths(this.dirs, this.files, this.filter);
  }

  /** One poll cycle: diff against the last snapshot, fire onChange if non-empty, advance the snapshot. Directly callable in tests. */
  poll(): void {
    const next = snapshotPaths(this.dirs, this.files, this.filter);
    const diff = diffSnapshots(this.snapshot, next);
    this.snapshot = next;
    if (!isEmptyDiff(diff)) this.onChange(diff);
  }

  start(): void {
    if (this.timer) return;
    this.prime();
    this.timer = setInterval(() => this.poll(), this.intervalMs);
    (this.timer as { unref?: () => void }).unref?.();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }
}
