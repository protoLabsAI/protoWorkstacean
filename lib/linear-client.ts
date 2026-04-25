/**
 * LinearClient — thin wrapper around @linear/sdk for the outbound operations
 * the bus publishes (`linear.reply.{issueId}`, `linear.update.issue.#`,
 * `linear.create.issue`). Keeps the plugin's outbound subscriber focused on
 * shape-translation rather than SDK idiosyncrasies.
 *
 * The SDK already handles GraphQL auth + retries + schema validation, so this
 * layer is deliberately a narrow adapter:
 *   - resolve human-friendly teamKey → teamId (cached with TTL)
 *   - resolve state name → stateId (cached per team with TTL)
 *   - coerce priority strings to the 0-4 ints Linear expects
 *
 * Priority semantics: Linear's `0` is the literal "No priority" value, NOT
 * "leave unchanged". Passing `priority: "none"` to updateIssue() will set the
 * issue to No priority. Pass `priority: undefined` (omit the field) to leave
 * priority untouched.
 */

import { LinearClient as LinearSdkClient } from "@linear/sdk";

export type LinearPriority = "urgent" | "high" | "medium" | "low" | "none";

const PRIORITY_MAP: Record<LinearPriority, number> = {
  urgent: 1,
  high: 2,
  medium: 3,
  low: 4,
  none: 0,
};

/**
 * Cache TTL for team-id and state-name lookups. Linear teams + workflow
 * states rarely change, but a process-lifetime cache risks holding stale
 * mappings across a workspace re-org. 10 min strikes a reasonable balance.
 */
const CACHE_TTL_MS = 10 * 60 * 1000;

export interface CreateIssueInput {
  teamKey: string;
  title: string;
  description?: string;
  priority?: LinearPriority;
  assigneeId?: string;
  labelIds?: string[];
  stateName?: string;
}

export interface UpdateIssueInput {
  stateName?: string;
  priority?: LinearPriority;
  assigneeId?: string;
  labelIds?: string[];
}

export type UpdateIssueResult =
  | { success: true }
  | { success: false; reason: string };

interface CacheEntry<V> { value: V; expiresAt: number; }

export class LinearClient {
  private readonly sdk: LinearSdkClient;
  private teamIdCache = new Map<string, CacheEntry<string>>();
  private stateCache = new Map<string, CacheEntry<Map<string, string>>>();

  constructor(apiKey: string) {
    this.sdk = new LinearSdkClient({ apiKey });
  }

  /**
   * Resolve a team key (e.g. "ENG") to its UUID. Cached with TTL — Linear
   * team keys are stable, but the cache TTL bounds drift after a re-org.
   */
  async resolveTeamId(teamKey: string): Promise<string | null> {
    const now = Date.now();
    const cached = this.teamIdCache.get(teamKey);
    if (cached && cached.expiresAt > now) return cached.value;
    const teams = await this.sdk.teams({ filter: { key: { eq: teamKey } }, first: 1 });
    const team = teams.nodes[0];
    if (!team) return null;
    this.teamIdCache.set(teamKey, { value: team.id, expiresAt: now + CACHE_TTL_MS });
    return team.id;
  }

  /**
   * Resolve a state name (e.g. "In Progress") to its UUID within a team.
   * Case-insensitive. Cached per team with TTL.
   */
  async resolveStateId(teamId: string, stateName: string): Promise<string | null> {
    const now = Date.now();
    const cached = this.stateCache.get(teamId);
    let teamStates: Map<string, string>;
    if (cached && cached.expiresAt > now) {
      teamStates = cached.value;
    } else {
      teamStates = new Map();
      const states = await this.sdk.workflowStates({
        filter: { team: { id: { eq: teamId } } },
        first: 50,
      });
      for (const s of states.nodes) {
        teamStates.set(s.name.toLowerCase(), s.id);
      }
      this.stateCache.set(teamId, { value: teamStates, expiresAt: now + CACHE_TTL_MS });
    }
    return teamStates.get(stateName.toLowerCase()) ?? null;
  }

  /** Drop all cached lookups. Useful for tests and after known workspace edits. */
  invalidateCache(): void {
    this.teamIdCache.clear();
    this.stateCache.clear();
  }

  /** Post a comment on an issue. Returns true on success. */
  async addComment(issueId: string, body: string): Promise<boolean> {
    const result = await this.sdk.createComment({ issueId, body });
    return Boolean(result.success);
  }

  /** Create an issue. Returns the new issue id on success, null otherwise. */
  async createIssue(input: CreateIssueInput): Promise<string | null> {
    const teamId = await this.resolveTeamId(input.teamKey);
    if (!teamId) return null;

    const stateId = input.stateName ? await this.resolveStateId(teamId, input.stateName) : undefined;
    const priorityInt = input.priority !== undefined ? PRIORITY_MAP[input.priority] : undefined;

    const result = await this.sdk.createIssue({
      teamId,
      title: input.title,
      description: input.description,
      priority: priorityInt,
      assigneeId: input.assigneeId,
      labelIds: input.labelIds,
      stateId,
    });
    if (!result.success) return null;
    const issue = await result.issue;
    return issue?.id ?? null;
  }

  /**
   * Update an issue. Returns a tagged result so the caller can distinguish
   * "no fields to update" from "API call failed" — both used to come back as
   * a bare `false` and were indistinguishable.
   *
   * `priority: "none"` sets Linear's "No priority" (value 0). Pass undefined
   * (omit the field) to leave the existing priority untouched.
   */
  async updateIssue(issueId: string, input: UpdateIssueInput): Promise<UpdateIssueResult> {
    const update: Record<string, unknown> = {};
    // !== undefined so the explicit "none" → 0 mapping reaches Linear,
    // matching the documented semantics.
    if (input.priority !== undefined) update.priority = PRIORITY_MAP[input.priority];
    if (input.assigneeId !== undefined) update.assigneeId = input.assigneeId;
    if (input.labelIds !== undefined) update.labelIds = input.labelIds;

    if (input.stateName) {
      const issue = await this.sdk.issue(issueId);
      const teamId = (await issue.team)?.id;
      if (!teamId) {
        return { success: false, reason: `issue ${issueId} has no team` };
      }
      const stateId = await this.resolveStateId(teamId, input.stateName);
      if (!stateId) {
        return {
          success: false,
          reason: `state name '${input.stateName}' not found on team ${teamId}`,
        };
      }
      update.stateId = stateId;
    }

    if (Object.keys(update).length === 0) {
      return { success: false, reason: "no fields supplied to update" };
    }

    const result = await this.sdk.updateIssue(issueId, update);
    if (!result.success) {
      return { success: false, reason: "Linear updateIssue mutation returned success=false" };
    }
    return { success: true };
  }
}
