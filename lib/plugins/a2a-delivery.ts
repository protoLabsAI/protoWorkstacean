/**
 * A2ADeliveryPlugin — delivers cron-fired schedules with `payload.channel:
 * "a2a"` to remote A2A endpoints (e.g. protoAgent forks). Acts as the
 * outbound counterpart to the local skill-resolver path that signal/cli
 * channels go through.
 *
 * Flow:
 *   SchedulerPlugin fires → publishes cron.<topic> with channel: "a2a"
 *     → A2ADeliveryPlugin subscribes cron.# → looks up targets[agent_name]
 *       → POSTs JSON-RPC message/send to target.url
 *
 * Config: workspace/a2a.yaml — `targets` map keyed by agent_name.
 */
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import * as YAML from "yaml";
import type { Plugin, EventBus, BusMessage } from "../types";

interface A2ATarget {
  url: string;
  bearer_token?: string;
  api_key?: string;
}

interface A2AConfig {
  targets?: Record<string, A2ATarget>;
}

interface CronPayloadForA2A {
  content: string;
  channel?: string;
  agent_name?: string;
  scheduler_job_id?: string;
  [key: string]: unknown;
}

const ENV_VAR = /\$\{([A-Z0-9_]+)\}/g;

function expandEnv(value: string | undefined): string | undefined {
  if (!value) return value;
  return value.replace(ENV_VAR, (_, name) => process.env[name] ?? "");
}

export class A2ADeliveryPlugin implements Plugin {
  name = "a2a-delivery";
  description = "Delivers cron schedules with channel: 'a2a' to remote A2A endpoints";
  capabilities: string[] = ["a2a", "outbound", "scheduler-delivery"];

  private bus: EventBus | null = null;
  private subscriptionId: string | null = null;
  private targets: Record<string, A2ATarget> = {};
  private readonly configPath: string;

  constructor(workspaceDir: string) {
    this.configPath = join(resolve(workspaceDir), "a2a.yaml");
  }

  install(bus: EventBus): void {
    this.bus = bus;
    this._loadConfig();

    this.subscriptionId = bus.subscribe("cron.#", this.name, (msg: BusMessage) => {
      void this._handle(msg);
    });

    const count = Object.keys(this.targets).length;
    console.log(`[a2a-delivery] Ready — ${count} target(s) configured`);
  }

  uninstall(): void {
    if (this.bus && this.subscriptionId) {
      this.bus.unsubscribe(this.subscriptionId);
    }
    this.subscriptionId = null;
    this.bus = null;
  }

  private _loadConfig(): void {
    if (!existsSync(this.configPath)) {
      this.targets = {};
      return;
    }
    try {
      const raw = readFileSync(this.configPath, "utf-8");
      const parsed = YAML.parse(raw) as A2AConfig | null;
      this.targets = parsed?.targets ?? {};
    } catch (err) {
      console.error(`[a2a-delivery] Failed to load ${this.configPath}:`, err);
      this.targets = {};
    }
  }

  private async _handle(msg: BusMessage): Promise<void> {
    const payload = msg.payload as CronPayloadForA2A | undefined;
    if (!payload || payload.channel !== "a2a") return;

    if (typeof payload.content !== "string" || payload.content.trim() === "") {
      console.error(
        `[a2a-delivery] cron "${msg.topic}" channel=a2a but payload.content is missing or not a non-empty string — drop`,
      );
      return;
    }

    const agentName = payload.agent_name;
    if (!agentName) {
      console.error(
        `[a2a-delivery] cron "${msg.topic}" channel=a2a but payload.agent_name is missing — drop`,
      );
      return;
    }

    const target = this.targets[agentName];
    if (!target) {
      console.error(
        `[a2a-delivery] cron "${msg.topic}" agent_name="${agentName}" has no configured target in ${this.configPath} — drop`,
      );
      return;
    }

    const url = expandEnv(target.url) ?? "";
    const bearer = expandEnv(target.bearer_token);
    const apiKey = expandEnv(target.api_key);

    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (bearer) headers["Authorization"] = `Bearer ${bearer}`;
    if (apiKey) headers["X-API-Key"] = apiKey;

    const body = {
      jsonrpc: "2.0" as const,
      id: crypto.randomUUID(),
      method: "message/send",
      params: {
        message: {
          messageId: crypto.randomUUID(),
          role: "user",
          parts: [{ kind: "text", text: payload.content }],
          metadata: {
            scheduler_job_id: payload.scheduler_job_id,
            channel: "a2a",
            agent_name: agentName,
          },
        },
      },
    };

    try {
      const res = await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new Error(`HTTP ${res.status} ${res.statusText}: ${text.slice(0, 200)}`);
      }
      console.log(
        `[a2a-delivery] Delivered cron "${msg.topic}" → ${agentName} (${url})`,
      );
    } catch (err) {
      console.error(
        `[a2a-delivery] Delivery failed for cron "${msg.topic}" → ${agentName} (${url}):`,
        err,
      );
    }
  }
}
