/**
 * PullRequestTracker — tracks last reviewed SHA per repo/PR.
 *
 * Persists to workspace state (JSON file) so reviews survive container restarts.
 * Compares current HEAD SHA to last reviewed commit — skips review if unchanged.
 *
 * Storage: workspace/state/pr-tracker.json
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";

interface PRTrackerState {
  /** Map from "{owner}/{repo}#{prNumber}" to last reviewed SHA. */
  lastReviewedSha: Record<string, string>;
}

export class PullRequestTracker {
  private state: PRTrackerState = { lastReviewedSha: {} };
  private readonly statePath: string;

  constructor(stateDir: string) {
    this.statePath = join(stateDir, "pr-tracker.json");
    this._load();
  }

  /**
   * Get the last reviewed SHA for a PR.
   * Returns null if the PR has never been reviewed.
   */
  async getLastReviewedSha(
    owner: string,
    repo: string,
    prNumber: number,
  ): Promise<string | null> {
    const key = this._key(owner, repo, prNumber);
    return this.state.lastReviewedSha[key] ?? null;
  }

  /**
   * Update the last reviewed SHA for a PR.
   * Called after a successful review submission.
   */
  async setLastReviewedSha(
    owner: string,
    repo: string,
    prNumber: number,
    sha: string,
  ): Promise<void> {
    const key = this._key(owner, repo, prNumber);
    this.state.lastReviewedSha[key] = sha;
    this._persist();
  }

  /**
   * Remove tracking for a PR (e.g. after merge/close).
   */
  async clearPR(
    owner: string,
    repo: string,
    prNumber: number,
  ): Promise<void> {
    const key = this._key(owner, repo, prNumber);
    delete this.state.lastReviewedSha[key];
    this._persist();
  }

  private _key(owner: string, repo: string, prNumber: number): string {
    return `${owner}/${repo}#${prNumber}`;
  }

  private _load(): void {
    if (!existsSync(this.statePath)) return;
    try {
      const raw = readFileSync(this.statePath, "utf8");
      this.state = JSON.parse(raw) as PRTrackerState;
    } catch {
      console.warn("[prTracker] Failed to load state, starting fresh");
      this.state = { lastReviewedSha: {} };
    }
  }

  private _persist(): void {
    const dir = dirname(this.statePath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    writeFileSync(this.statePath, JSON.stringify(this.state, null, 2), "utf8");
  }
}
