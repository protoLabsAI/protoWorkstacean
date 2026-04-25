/**
 * OnboardingPlugin — deterministic project onboarding pipeline.
 *
 * Each step is idempotent: re-running for the same project slug is safe.
 *
 * Steps:
 *   1. validate       — check required fields, validate github format
 *   2. idempotency    — skip if project slug already in projects.yaml
 *   3. github_webhook — register GitHub webhook (no-op if no GitHub auth)
 *   4. drive_folder   — create per-project Drive folder under the org root
 *   5. projects_yaml  — upsert project entry into workspace/projects.yaml
 *   6. bus_notify     — publish message.inbound.onboard.complete for downstream consumers
 *   7. reply          — send confirmation to reply topic / Discord
 *
 * Inbound triggers:
 *   message.inbound.onboard   (from POST /api/onboard or Discord /onboard command)
 *
 * Outbound topics:
 *   message.inbound.onboard.complete — project metadata after successful onboarding
 *   msg.reply.topic                  — confirmation text back to caller
 *
 * Env vars:
 *   QUINN_APP_ID, QUINN_APP_PRIVATE_KEY, GITHUB_TOKEN
 *   GITHUB_WEBHOOK_SECRET
 *   WORKSTACEAN_PUBLIC_URL  base URL for webhook registration (e.g. https://ws.example.com)
 */

import { readFileSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import type { EventBus, BusMessage, Plugin } from "../types.ts";
import { makeGitHubAuth } from "../github-auth.ts";
import { validateProjectEntry } from "../project-schema.ts";
import { createDriveFolder } from "./google.ts";

// ── In-process write lock for projects.yaml ───────────────────────────────────
// Serialises concurrent onboarding writes to prevent TOCTOU races when two
// different slugs are onboarded simultaneously in the same Bun process.

let _projectsYamlLockChain: Promise<void> = Promise.resolve();

function withProjectsYamlLock(fn: () => void): Promise<void> {
  const next = _projectsYamlLockChain.then(fn);
  _projectsYamlLockChain = next.catch(() => {});
  return next;
}

// ── Request / response types ──────────────────────────────────────────────────

interface OnboardRequest {
  slug: string;              // e.g. "protolabsai-myproject"
  title: string;             // human-readable project name
  github: string;            // "owner/repo"
  defaultBranch?: string;    // default: "main"
  team?: string;             // "dev" | "gtm" | etc.
  agents?: string[];         // ["protomaker", "quinn", "frank"]
  discord?: {
    general?: string;
    updates?: string;
    dev?: string;
    alerts?: string;
    releases?: string;
  };
}

interface StepResult {
  status: "ok" | "skip" | "error";
  detail?: string;
  data?: Record<string, unknown>;
}

interface OnboardSteps {
  githubWebhook?: StepResult;
  driveFolder?: StepResult & { folderId?: string };
  projectsYaml?: StepResult;
}

// ── GitHub webhook helpers ────────────────────────────────────────────────────

async function listGitHubWebhooks(
  owner: string,
  repo: string,
  token: string,
): Promise<{ id: number; config: { url?: string } }[]> {
  const resp = await fetch(
    `https://api.github.com/repos/${owner}/${repo}/hooks`,
    {
      headers: {
        Authorization: `Bearer ${token}`,
        "User-Agent": "protoWorkstacean/1.0",
        "X-GitHub-Api-Version": "2022-11-28",
      },
      signal: AbortSignal.timeout(10_000),
    },
  );
  if (!resp.ok) return [];
  return (await resp.json()) as { id: number; config: { url?: string } }[];
}

async function createGitHubWebhook(
  owner: string,
  repo: string,
  webhookUrl: string,
  token: string,
  secret?: string,
): Promise<boolean> {
  const body: Record<string, unknown> = {
    name: "web",
    active: true,
    events: ["issues", "issue_comment", "pull_request", "pull_request_review_comment"],
    config: {
      url: webhookUrl,
      content_type: "json",
      insecure_ssl: "0",
      ...(secret ? { secret } : {}),
    },
  };

  const resp = await fetch(
    `https://api.github.com/repos/${owner}/${repo}/hooks`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        "User-Agent": "protoWorkstacean/1.0",
        "X-GitHub-Api-Version": "2022-11-28",
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    },
  );

  return resp.ok;
}

// ── projects.yaml helpers ─────────────────────────────────────────────────────

interface ProjectsYaml {
  projects: Record<string, unknown>[];
}

function readProjectsYaml(projectsPath: string): ProjectsYaml {
  if (!existsSync(projectsPath)) return { projects: [] };
  try {
    const raw = readFileSync(projectsPath, "utf8");
    const parsed = parseYaml(raw) as ProjectsYaml;
    return { projects: parsed.projects ?? [] };
  } catch {
    return { projects: [] };
  }
}

function projectSlugExists(projectsPath: string, slug: string): boolean {
  const { projects } = readProjectsYaml(projectsPath);
  return projects.some(p => (p as Record<string, unknown>).slug === slug);
}

// ── Plugin ────────────────────────────────────────────────────────────────────

export class OnboardingPlugin implements Plugin {
  readonly name = "onboarding";
  readonly description = "Deterministic project onboarding pipeline — 8 idempotent steps";
  readonly capabilities = ["onboarding"];

  private workspaceDir: string;
  // Prevent duplicate concurrent runs for the same slug
  private inFlight = new Set<string>();

  constructor(workspaceDir: string) {
    this.workspaceDir = workspaceDir;
  }

  install(bus: EventBus): void {
    bus.subscribe("message.inbound.onboard", "onboarding", async (msg: BusMessage) => {
      await this._run(bus, msg).catch(err => {
        console.error("[onboarding] Unhandled pipeline error:", err);
      });
    });
    console.log("[onboarding] Plugin installed — listening on message.inbound.onboard");
  }

  uninstall(): void {}

  // ── Pipeline entry point ───────────────────────────────────────────────────

  private async _run(bus: EventBus, msg: BusMessage): Promise<void> {
    const payload = msg.payload as Record<string, unknown>;

    // ── Step 1: Validate ────────────────────────────────────────────────────
    const req = this._parseRequest(payload);
    if (!req) {
      console.warn("[onboarding] Step 1 validate: missing required fields (slug, title, github)");
      this._reply(bus, msg, {
        success: false,
        step: "validate",
        error: "Missing required fields: slug, title, github (owner/repo)",
      });
      return;
    }
    if (!/^[^/]+\/[^/]+$/.test(req.github)) {
      console.warn(`[onboarding] Step 1 validate: invalid github format "${req.github}"`);
      this._reply(bus, msg, {
        success: false,
        step: "validate",
        error: `Invalid github format "${req.github}" — expected "owner/repo"`,
      });
      return;
    }

    // Prevent concurrent runs for same slug
    if (this.inFlight.has(req.slug)) {
      console.log(`[onboarding] ${req.slug}: already in-flight — skipping duplicate`);
      this._reply(bus, msg, {
        success: false,
        step: "validate",
        error: `Onboarding for "${req.slug}" is already in progress`,
      });
      return;
    }
    this.inFlight.add(req.slug);

    try {
      await this._pipeline(bus, msg, req);
    } finally {
      this.inFlight.delete(req.slug);
    }
  }

  private async _pipeline(bus: EventBus, msg: BusMessage, req: OnboardRequest): Promise<void> {
    const projectsPath = join(this.workspaceDir, "projects.yaml");

    // ── Step 2: Idempotency check ────────────────────────────────────────────
    if (projectSlugExists(projectsPath, req.slug)) {
      console.log(`[onboarding] ${req.slug}: already onboarded — skipping`);
      this._reply(bus, msg, {
        success: true,
        step: "idempotency",
        status: "already_onboarded",
        slug: req.slug,
        message: `Project "${req.slug}" is already registered in projects.yaml`,
      });
      return;
    }

    console.log(`[onboarding] Starting pipeline for "${req.slug}" (${req.github})`);
    const steps: OnboardSteps = {};

    // ── Step 3: GitHub webhook ───────────────────────────────────────────────
    steps.githubWebhook = await this._stepGitHubWebhook(req);
    console.log(`[onboarding] Step 3 github_webhook: ${steps.githubWebhook.status} — ${steps.githubWebhook.detail ?? ""}`);

    // ── Step 4: Drive folder creation ────────────────────────────────────────
    steps.driveFolder = await this._stepDriveFolder(req);
    console.log(`[onboarding] Step 4 drive_folder: ${steps.driveFolder.status} — ${steps.driveFolder.detail ?? ""}`);

    // ── Step 5: Update projects.yaml (serialised to prevent TOCTOU races) ────
    const driveFolderId = steps.driveFolder?.data?.folderId as string | undefined;
    await withProjectsYamlLock(() => {
      steps.projectsYaml = this._stepUpdateProjectsYaml(req, projectsPath, driveFolderId);
    });
    console.log(`[onboarding] Step 5 projects_yaml: ${steps.projectsYaml!.status} — ${steps.projectsYaml!.detail ?? ""}`);

    if (steps.projectsYaml!.status === "error") {
      this._reply(bus, msg, {
        success: false,
        step: "projects_yaml",
        error: steps.projectsYaml!.detail ?? "Failed to write projects.yaml",
      });
      return;
    }

    // ── Step 6: Bus notify ───────────────────────────────────────────────────
    this._stepBusNotify(bus, req, steps, msg.correlationId);
    console.log(`[onboarding] Step 6 bus_notify: ok — published message.inbound.onboard.complete`);

    // ── Step 7: Reply ────────────────────────────────────────────────────────
    const summary = this._buildSummary(req, steps);
    console.log(`[onboarding] Step 7 reply: ok — ${req.slug} onboarded`);
    this._reply(bus, msg, {
      success: true,
      step: "complete",
      status: "onboarded",
      slug: req.slug,
      github: req.github,
      summary,
      steps: {
        githubWebhook: steps.githubWebhook?.status,
        driveFolder: steps.driveFolder?.status,
        projectsYaml: steps.projectsYaml?.status,
      },
    });
  }

  // ── Step implementations ───────────────────────────────────────────────────

  /** Step 3: Register GitHub webhook. */
  private async _stepGitHubWebhook(req: OnboardRequest): Promise<StepResult> {
    const getToken = makeGitHubAuth();
    if (!getToken) {
      return { status: "skip", detail: "No GitHub auth configured (QUINN_APP_ID or GITHUB_TOKEN required)" };
    }

    const publicUrl = process.env.WORKSTACEAN_PUBLIC_URL;
    if (!publicUrl) {
      return { status: "skip", detail: "WORKSTACEAN_PUBLIC_URL not set — skipping GitHub webhook registration" };
    }

    const webhookUrl = `${publicUrl}/webhook/github`;
    const [owner, repo] = req.github.split("/");
    const secret = process.env.GITHUB_WEBHOOK_SECRET;

    try {
      const token = await getToken(owner, repo);

      // Idempotency: check if webhook pointing to our URL already exists
      const existing = await listGitHubWebhooks(owner, repo, token);
      if (existing.some(wh => wh.config.url === webhookUrl)) {
        return { status: "skip", detail: `GitHub webhook already registered for ${req.github}` };
      }

      const ok = await createGitHubWebhook(owner, repo, webhookUrl, token, secret);
      if (!ok) {
        return { status: "error", detail: `Failed to create GitHub webhook on ${req.github}` };
      }
      return { status: "ok", detail: `GitHub webhook registered on ${req.github} → ${webhookUrl}` };
    } catch (err) {
      return {
        status: "error",
        detail: `GitHub webhook registration failed: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  /** Step 4: Create Drive folder for this project under the org root. */
  private async _stepDriveFolder(req: OnboardRequest): Promise<StepResult & { folderId?: string }> {
    if (!process.env.GOOGLE_CLIENT_ID || !process.env.GOOGLE_CLIENT_SECRET || !process.env.GOOGLE_REFRESH_TOKEN) {
      return { status: "skip", detail: "Google credentials not set — skipping Drive folder creation" };
    }

    // Load org folder ID from google.yaml
    const googleYamlPath = join(this.workspaceDir, "google.yaml");
    if (!existsSync(googleYamlPath)) {
      return { status: "skip", detail: "workspace/google.yaml not found — skipping Drive folder creation" };
    }

    let orgFolderId = "";
    try {
      const raw = readFileSync(googleYamlPath, "utf8");
      const cfg = parseYaml(raw) as { drive?: { orgFolderId?: string } };
      orgFolderId = cfg.drive?.orgFolderId ?? "";
    } catch (err) {
      return {
        status: "error",
        detail: `Failed to read google.yaml: ${err instanceof Error ? err.message : String(err)}`,
      };
    }

    if (!orgFolderId) {
      return { status: "skip", detail: "drive.orgFolderId not set in google.yaml — skipping Drive folder creation" };
    }

    try {
      const folder = await createDriveFolder(req.title, orgFolderId);
      if (!folder) {
        return { status: "error", detail: `Drive folder creation failed for project "${req.slug}"` };
      }
      return {
        status: "ok",
        detail: `Created Drive folder "${folder.name}" (${folder.id})`,
        data: { folderId: folder.id },
        folderId: folder.id,
      };
    } catch (err) {
      return {
        status: "error",
        detail: `Drive folder creation error: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  /** Step 5: Upsert project entry into workspace/projects.yaml. */
  private _stepUpdateProjectsYaml(
    req: OnboardRequest,
    projectsPath: string,
    driveFolderId?: string,
  ): StepResult {
    try {
      // Double-check idempotency (guard against race between two concurrent runs)
      if (projectSlugExists(projectsPath, req.slug)) {
        return { status: "skip", detail: `Slug "${req.slug}" already present — skipping write` };
      }

      const { projects } = readProjectsYaml(projectsPath);

      const entry: Record<string, unknown> = {
        slug: req.slug,
        title: req.title,
        team: req.team ?? "dev",
        github: req.github,
        defaultBranch: req.defaultBranch ?? "main",
        status: "active",
        onboardedAt: new Date().toISOString(),
        agents: req.agents ?? ["protomaker", "quinn"],
        // Ensure discord.dev is always present (required by schema)
        discord: {
          dev: "",
          ...(req.discord ?? {}),
        },
      };

      // Add Google Workspace metadata (folder ID populated if Drive step succeeded)
      entry.googleWorkspace = {
        driveFolderId: driveFolderId ?? "",
        sharedDocId: "",
        calendarId: "",
      };

      // Validate the entry against the project schema before writing
      const validation = validateProjectEntry(entry);
      if (!validation.ok) {
        return {
          status: "error",
          detail: `Schema validation failed: ${validation.errors.join("; ")}`,
        };
      }

      projects.push(entry);

      // Preserve header comment if present
      let existingContent = "";
      if (existsSync(projectsPath)) {
        existingContent = readFileSync(projectsPath, "utf8");
      }
      const headerMatch = existingContent.match(/^(#[^\n]*\n)*/);
      const header = headerMatch ? headerMatch[0] : "";

      const newContent = header + stringifyYaml({ projects }, { lineWidth: 120 });
      writeFileSync(projectsPath, newContent, "utf8");

      return { status: "ok", detail: `Appended "${req.slug}" to projects.yaml` };
    } catch (err) {
      return {
        status: "error",
        detail: `Failed to write projects.yaml: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  /** Step 6: Publish completion event to bus. */
  private _stepBusNotify(
    bus: EventBus,
    req: OnboardRequest,
    steps: OnboardSteps,
    correlationId: string,
  ): void {
    const topic = "message.inbound.onboard.complete";
    bus.publish(topic, {
      id: crypto.randomUUID(),
      correlationId,
      topic,
      timestamp: Date.now(),
      payload: {
        slug: req.slug,
        title: req.title,
        github: req.github,
        defaultBranch: req.defaultBranch ?? "main",
        team: req.team ?? "dev",
        agents: req.agents ?? ["protomaker", "quinn"],
        discord: req.discord ?? {},
        driveFolderId: steps.driveFolder?.data?.folderId,
        steps: {
          githubWebhook: steps.githubWebhook?.status,
          driveFolder: steps.driveFolder?.status,
        },
      },
    });
  }

  // ── Helpers ────────────────────────────────────────────────────────────────

  private _parseRequest(payload: Record<string, unknown>): OnboardRequest | null {
    const slug = typeof payload.slug === "string" ? payload.slug.trim() : "";
    const title = typeof payload.title === "string" ? payload.title.trim() : "";
    const github = typeof payload.github === "string" ? payload.github.trim() : "";

    if (!slug || !title || !github) return null;

    return {
      slug,
      title,
      github,
      defaultBranch: typeof payload.defaultBranch === "string" ? payload.defaultBranch : "main",
      team: typeof payload.team === "string" ? payload.team : undefined,
      agents: Array.isArray(payload.agents) ? payload.agents as string[] : undefined,
      discord: payload.discord as OnboardRequest["discord"] | undefined,
    };
  }

  private _reply(bus: EventBus, msg: BusMessage, result: Record<string, unknown>): void {
    const replyTopic = msg.reply?.topic;
    if (!replyTopic) return;

    const content = result.success
      ? `✅ Project onboarding ${result.status === "already_onboarded" ? "already complete" : "complete"}: **${result.slug}**\n${result.summary ?? ""}`
      : `❌ Onboarding failed at step \`${result.step}\`: ${result.error}`;

    bus.publish(replyTopic, {
      id: crypto.randomUUID(),
      correlationId: msg.correlationId,
      topic: replyTopic,
      timestamp: Date.now(),
      payload: { ...result, content },
    });
  }

  private _buildSummary(req: OnboardRequest, steps: OnboardSteps): string {
    const lines = [
      `**${req.title}** (\`${req.slug}\`)`,
      `GitHub: \`${req.github}\``,
      "",
      "Steps:",
      `  • GitHub webhook: ${this._statusEmoji(steps.githubWebhook?.status)} ${steps.githubWebhook?.detail ?? ""}`,
      `  • Drive folder: ${this._statusEmoji(steps.driveFolder?.status)} ${steps.driveFolder?.detail ?? ""}`,
      `  • projects.yaml: ${this._statusEmoji(steps.projectsYaml?.status)} ${steps.projectsYaml?.detail ?? ""}`,
    ];
    return lines.join("\n");
  }

  private _statusEmoji(status?: string): string {
    if (status === "ok") return "✅";
    if (status === "skip") return "⏭️";
    if (status === "error") return "⚠️";
    return "❓";
  }
}
