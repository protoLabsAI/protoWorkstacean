/**
 * ProtoMakerBoardBridge — forwards GitHub issues on registered project repos
 * into protoMaker's board as backlog ideas.
 *
 * The switchboard pattern (ADR-0001 / ADR-0002): protoWorkstacean already
 * receives every project repo's GitHub webhook AND owns the project registry
 * (`getByGithub`). So it resolves the project here and POSTs to protoMaker's
 * dumb HTTP board-ingestion intake — protoMaker stops needing to receive
 * webhooks or route by repo. Everything flows switchboard → HTTP intake.
 *
 * Inbound:  github.issue.opened   (published by GitHubPlugin)
 * Outbound: POST {PROTOMAKER_API_BASE}/api/engine/signal/submit  (X-API-Key)
 *
 * protoMaker's `SignalIntakeService.submitSignal` honors the provided
 * `channelContext.projectPath` over the default and dedups on
 * `github:{repository}#{issueNumber}`, so a reopened/redelivered issue won't
 * double-create.
 *
 * Issues on repos NOT in the registry are ignored here (workstacean's own
 * triage path handles those independently).
 */

import type { EventBus, BusMessage, Plugin } from "../types.ts";
import type { ProjectRegistry } from "../../src/plugins/project-registry.ts";
import type { GithubIssueOpenedPayload } from "../../src/event-bus/payloads.ts";

const DEFAULT_PROTOMAKER_BASE = "http://protomaker-server:3008";

export interface BoardIngestSignal {
  source: string;
  content: string;
  channelContext: {
    projectPath: string;
    issueNumber: number;
    repository: string;
  };
  /**
   * Cross-system Langfuse trace linkage. `traceId` is the originating
   * correlationId (the trace id for this issue's flow). protoMaker sets it as
   * the trace id / `caller_trace_id` on its signal→FeatureLoader→PMAgent spans
   * so the whole GitHub→board→PRD flow is one trace. Mirrors the `a2a.trace`
   * convention used for cross-agent A2A linking.
   */
  trace: {
    traceId: string;
    caller: "workstacean";
    source: "github.issue.opened";
  };
}

/**
 * Pure builder for the protoMaker `signal/submit` body — exported for testing.
 * `content` is title + body so the board idea is self-describing.
 */
export function buildBoardIngestSignal(
  issue: GithubIssueOpenedPayload,
  projectPath: string,
  traceId: string,
): BoardIngestSignal {
  const repository = `${issue.owner}/${issue.repo}`;
  const title = issue.title || `Issue #${issue.number}`;
  const content = issue.body ? `${title}\n\n${issue.body}` : title;
  return {
    source: "github",
    content,
    channelContext: { projectPath, issueNumber: issue.number, repository },
    trace: { traceId, caller: "workstacean", source: "github.issue.opened" },
  };
}

export class ProtoMakerBoardBridgePlugin implements Plugin {
  readonly name = "protomaker-board-bridge";
  readonly description =
    "Forwards GitHub issues on registered project repos to protoMaker's board intake";
  readonly capabilities = ["protomaker-board-ingest"];
  readonly subscribes = ["github.issue.opened"];

  private readonly registry: ProjectRegistry;
  private readonly baseUrl: string;
  private readonly apiKey?: string;

  constructor(
    registry: ProjectRegistry,
    opts: { baseUrl?: string; apiKey?: string } = {},
  ) {
    this.registry = registry;
    this.baseUrl = (opts.baseUrl ?? process.env["PROTOMAKER_API_BASE"] ?? DEFAULT_PROTOMAKER_BASE).replace(/\/$/, "");
    this.apiKey = opts.apiKey ?? process.env["AUTOMAKER_API_KEY"];
  }

  install(bus: EventBus): void {
    bus.subscribe("github.issue.opened", this.name, (msg: BusMessage) => {
      void this._forward(msg).catch((err) => {
        // Fire-and-forget subscriber — surface loudly, can't return to a caller.
        console.error(
          `[protomaker-board-bridge] forward failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      });
    });
  }

  uninstall(): void {}

  private async _forward(msg: BusMessage): Promise<void> {
    const issue = msg.payload as GithubIssueOpenedPayload | undefined;
    if (!issue?.owner || !issue?.repo || typeof issue.number !== "number") return;

    const project = this.registry.getByGithub(`${issue.owner}/${issue.repo}`);
    if (!project) return; // not a managed project repo — workstacean triage owns it

    if (!this.apiKey) {
      console.warn(
        `[protomaker-board-bridge] AUTOMAKER_API_KEY not set — cannot forward ${issue.owner}/${issue.repo}#${issue.number}`,
      );
      return;
    }

    // correlationId is the trace id for this issue's flow (set when the github
    // plugin published github.issue.opened) — propagate it so protoMaker links.
    const traceId = msg.correlationId || crypto.randomUUID();
    const signal = buildBoardIngestSignal(issue, project.path, traceId);
    const resp = await fetch(`${this.baseUrl}/api/engine/signal/submit`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-API-Key": this.apiKey },
      body: JSON.stringify(signal),
      signal: AbortSignal.timeout(10_000),
    });
    if (!resp.ok) {
      throw new Error(
        `protoMaker signal/submit ${resp.status}: ${(await resp.text()).slice(0, 200)}`,
      );
    }
    console.log(
      `[protomaker-board-bridge] ${issue.owner}/${issue.repo}#${issue.number} → board "${project.slug}" (${project.path})`,
    );
  }
}
