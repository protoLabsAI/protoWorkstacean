/**
 * LinearClient — thin wrapper around @linear/sdk for the outbound operations
 * the bus publishes (`linear.reply.{issueId}`, `linear.update.issue.#`,
 * `linear.create.issue`). Keeps the plugin's outbound subscriber focused on
 * shape-translation rather than SDK idiosyncrasies.
 *
 * The SDK already handles GraphQL auth + retries + schema validation, so this
 * layer is deliberately a narrow adapter:
 *   - resolve human-friendly teamKey → teamId
 *   - resolve state name → stateId (cached per team)
 *   - coerce priority strings to the 0-4 ints Linear expects
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

export class LinearClient {
  private readonly sdk: LinearSdkClient;
  private teamIdCache = new Map<string, string>();
  private stateCache = new Map<string, Map<string, string>>();

  constructor(apiKey: string) {
    this.sdk = new LinearSdkClient({ apiKey });
  }

  /**
   * Resolve a team key (e.g. "ENG") to its UUID. Cached — Linear team keys
   * are stable strings, so a process-lifetime cache is safe.
   */
  async resolveTeamId(teamKey: string): Promise<string | null> {
    const cached = this.teamIdCache.get(teamKey);
    if (cached) return cached;
    const teams = await this.sdk.teams({ filter: { key: { eq: teamKey } }, first: 1 });
    const team = teams.nodes[0];
    if (!team) return null;
    this.teamIdCache.set(teamKey, team.id);
    return team.id;
  }

  /**
   * Resolve a state name (e.g. "In Progress") to its UUID within a team.
   * Case-insensitive. Cached per team.
   */
  async resolveStateId(teamId: string, stateName: string): Promise<string | null> {
    let teamStates = this.stateCache.get(teamId);
    if (!teamStates) {
      teamStates = new Map();
      const states = await this.sdk.workflowStates({
        filter: { team: { id: { eq: teamId } } },
        first: 50,
      });
      for (const s of states.nodes) {
        teamStates.set(s.name.toLowerCase(), s.id);
      }
      this.stateCache.set(teamId, teamStates);
    }
    return teamStates.get(stateName.toLowerCase()) ?? null;
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
    const priorityInt = input.priority ? PRIORITY_MAP[input.priority] : undefined;

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

  /** Update an issue's state/priority/assignee/labels. Returns true on success. */
  async updateIssue(issueId: string, input: UpdateIssueInput): Promise<boolean> {
    const update: Record<string, unknown> = {};
    if (input.priority) update.priority = PRIORITY_MAP[input.priority];
    if (input.assigneeId) update.assigneeId = input.assigneeId;
    if (input.labelIds) update.labelIds = input.labelIds;

    if (input.stateName) {
      const issue = await this.sdk.issue(issueId);
      const teamId = (await issue.team)?.id;
      if (teamId) {
        const stateId = await this.resolveStateId(teamId, input.stateName);
        if (stateId) update.stateId = stateId;
      }
    }

    if (Object.keys(update).length === 0) return false;
    const result = await this.sdk.updateIssue(issueId, update);
    return Boolean(result.success);
  }
}
