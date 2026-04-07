/**
 * PlaneClient — REST API client for Plane project management.
 *
 * Extracted from lib/plugins/plane.ts so both PlanePlugin (issue state sync)
 * and OnboardingPlugin (project creation, webhook registration) can share it.
 *
 * Env vars used by callers:
 *   PLANE_API_KEY         API key for outbound calls to Plane
 *   PLANE_BASE_URL        default: http://ava:3002
 *   PLANE_WORKSPACE_SLUG  default: protolabsai
 */

// ── Types ─────────────────────────────────────────────────────────────────────

export interface PlaneLabel {
  id: string;
  name: string;
}

export interface PlaneState {
  id: string;
  name: string;
  group: string;
}

export interface PlanePlaneProject {
  id: string;
  identifier: string;
  name: string;
  [key: string]: unknown;
}

export interface PlaneWebhook {
  id: string;
  url: string;
  [key: string]: unknown;
}

// ── Helpers ────────────────────────────────────────────────────────────────────

/** Escape HTML entities to prevent XSS when embedding text in comment_html. */
function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

// ── PlaneClient ───────────────────────────────────────────────────────────────

export class PlaneClient {
  private baseUrl: string;
  private workspaceSlug: string;
  private apiKey: string;

  // projectId → label UUID → label name
  private labelCache = new Map<string, Map<string, string>>();
  // projectId → state group/name → state UUID
  private stateCache = new Map<string, Map<string, string>>();

  constructor(baseUrl: string, workspaceSlug: string, apiKey: string) {
    this.baseUrl = baseUrl;
    this.workspaceSlug = workspaceSlug;
    this.apiKey = apiKey;
  }

  private headers(): Record<string, string> {
    return {
      "X-Api-Key": this.apiKey,
      "Content-Type": "application/json",
    };
  }

  // ── Label/state cache (used by PlanePlugin for issue state sync) ──────────

  async fetchLabels(projectId: string): Promise<Map<string, string>> {
    if (this.labelCache.has(projectId)) return this.labelCache.get(projectId)!;

    const map = new Map<string, string>();
    try {
      const url = `${this.baseUrl}/api/v1/workspaces/${this.workspaceSlug}/projects/${projectId}/labels/`;
      const resp = await fetch(url, { headers: this.headers(), signal: AbortSignal.timeout(10_000) });
      if (resp.ok) {
        const data = (await resp.json()) as { results?: PlaneLabel[] };
        for (const label of data.results ?? []) {
          map.set(label.id, label.name.toLowerCase());
        }
      } else {
        console.warn(`[plane-client] Failed to fetch labels for project ${projectId}: ${resp.status}`);
      }
    } catch (err) {
      console.error("[plane-client] Error fetching labels:", err);
    }
    this.labelCache.set(projectId, map);
    return map;
  }

  async fetchStates(projectId: string): Promise<Map<string, string>> {
    if (this.stateCache.has(projectId)) return this.stateCache.get(projectId)!;

    const map = new Map<string, string>();
    try {
      const url = `${this.baseUrl}/api/v1/workspaces/${this.workspaceSlug}/projects/${projectId}/states/`;
      const resp = await fetch(url, { headers: this.headers(), signal: AbortSignal.timeout(10_000) });
      if (resp.ok) {
        const data = (await resp.json()) as { results?: PlaneState[] };
        for (const state of data.results ?? []) {
          // Namespace keys to prevent collisions between group names and state names
          // (e.g. a group called "started" vs a state named "started" in another group).
          // Callers must use the same prefixes: "group:<group>" or "name:<lowercase-name>".
          map.set(`group:${state.group}`, state.id);
          map.set(`name:${state.name.toLowerCase()}`, state.id);
        }
      } else {
        console.warn(`[plane-client] Failed to fetch states for project ${projectId}: ${resp.status}`);
      }
    } catch (err) {
      console.error("[plane-client] Error fetching states:", err);
    }
    this.stateCache.set(projectId, map);
    return map;
  }

  async hasLabel(projectId: string, labelUUIDs: string[], targetName: string): Promise<boolean> {
    const labels = await this.fetchLabels(projectId);
    return labelUUIDs.some(uuid => labels.get(uuid) === targetName.toLowerCase());
  }

  async patchIssueState(projectId: string, issueId: string, stateUUID: string): Promise<boolean> {
    try {
      const url = `${this.baseUrl}/api/v1/workspaces/${this.workspaceSlug}/projects/${projectId}/work-items/${issueId}/`;
      const resp = await fetch(url, {
        method: "PATCH",
        headers: this.headers(),
        body: JSON.stringify({ state: stateUUID }),
        signal: AbortSignal.timeout(10_000),
      });
      if (!resp.ok) {
        console.error(`[plane-client] PATCH issue state failed: ${resp.status} ${await resp.text()}`);
        return false;
      }
      return true;
    } catch (err) {
      console.error("[plane-client] Error patching issue state:", err);
      return false;
    }
  }

  async addIssueComment(projectId: string, issueId: string, comment: string): Promise<boolean> {
    try {
      const url = `${this.baseUrl}/api/v1/workspaces/${this.workspaceSlug}/projects/${projectId}/issues/${issueId}/comments/`;
      const resp = await fetch(url, {
        method: "POST",
        headers: this.headers(),
        body: JSON.stringify({ comment_html: `<p>${escapeHtml(comment)}</p>` }),
        signal: AbortSignal.timeout(10_000),
      });
      if (!resp.ok) {
        console.error(`[plane-client] POST issue comment failed: ${resp.status} ${await resp.text()}`);
        return false;
      }
      return true;
    } catch (err) {
      console.error("[plane-client] Error adding issue comment:", err);
      return false;
    }
  }

  /** Invalidate cached labels/states for a project so they're re-fetched next time. */
  invalidate(projectId: string): void {
    this.labelCache.delete(projectId);
    this.stateCache.delete(projectId);
  }

  // ── Project management (used by OnboardingPlugin) ─────────────────────────

  /** List all projects in the workspace. */
  async listProjects(): Promise<PlanePlaneProject[]> {
    try {
      const url = `${this.baseUrl}/api/v1/workspaces/${this.workspaceSlug}/projects/`;
      const resp = await fetch(url, { headers: this.headers(), signal: AbortSignal.timeout(10_000) });
      if (!resp.ok) {
        console.warn(`[plane-client] Failed to list projects: ${resp.status}`);
        return [];
      }
      const data = (await resp.json()) as { results?: PlanePlaneProject[] } | PlanePlaneProject[];
      return Array.isArray(data) ? data : (data.results ?? []);
    } catch (err) {
      console.error("[plane-client] Error listing projects:", err);
      return [];
    }
  }

  /**
   * Create a new project in the workspace.
   * Returns the created project or null on failure.
   * Idempotent: returns existing project if identifier already taken.
   */
  async createProject(
    name: string,
    identifier: string,
    description?: string,
  ): Promise<PlanePlaneProject | null> {
    // Idempotency: check if project with this identifier already exists
    const existing = await this.listProjects();
    const found = existing.find(p => p.identifier === identifier || p.name === name);
    if (found) {
      console.log(`[plane-client] Project "${identifier}" already exists (${found.id}) — skipping creation`);
      return found;
    }

    try {
      const url = `${this.baseUrl}/api/v1/workspaces/${this.workspaceSlug}/projects/`;
      const body: Record<string, unknown> = { name, identifier };
      if (description) body.description = description;

      const resp = await fetch(url, {
        method: "POST",
        headers: this.headers(),
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(15_000),
      });

      if (!resp.ok) {
        const text = await resp.text();
        console.error(`[plane-client] Failed to create project: ${resp.status} ${text}`);
        return null;
      }
      return (await resp.json()) as PlanePlaneProject;
    } catch (err) {
      console.error("[plane-client] Error creating project:", err);
      return null;
    }
  }

  /** List workspace-level webhooks. */
  async listWebhooks(): Promise<PlaneWebhook[]> {
    try {
      const url = `${this.baseUrl}/api/v1/workspaces/${this.workspaceSlug}/webhooks/`;
      const resp = await fetch(url, { headers: this.headers(), signal: AbortSignal.timeout(10_000) });
      if (!resp.ok) return [];
      const data = (await resp.json()) as { results?: PlaneWebhook[] } | PlaneWebhook[];
      return Array.isArray(data) ? data : (data.results ?? []);
    } catch (err) {
      console.error("[plane-client] Error listing webhooks:", err);
      return [];
    }
  }

  /**
   * Register a workspace-level webhook (Plane webhooks are workspace-scoped).
   * Idempotent: skips if a webhook with the same URL already exists.
   */
  async registerWebhook(webhookUrl: string, secret?: string): Promise<boolean> {
    try {
      const existing = await this.listWebhooks();
      if (existing.some(wh => wh.url === webhookUrl)) {
        console.log("[plane-client] Webhook already registered — skipping");
        return true;
      }

      const url = `${this.baseUrl}/api/v1/workspaces/${this.workspaceSlug}/webhooks/`;
      const body: Record<string, unknown> = {
        url: webhookUrl,
        is_active: true,
        issue: true,
        issue_comment: true,
        project: false,
        cycle: false,
        module: false,
      };
      if (secret) body.secret = secret;

      const resp = await fetch(url, {
        method: "POST",
        headers: this.headers(),
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(15_000),
      });

      if (!resp.ok) {
        const text = await resp.text();
        console.error(`[plane-client] Failed to register webhook: ${resp.status} ${text}`);
        return false;
      }
      return true;
    } catch (err) {
      console.error("[plane-client] Error registering webhook:", err);
      return false;
    }
  }
}
