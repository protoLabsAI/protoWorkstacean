import { resolve, dirname, join } from "node:path";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";
import type { Plugin, EventBus, BusMessage } from "../types";

const __dirname = dirname(fileURLToPath(import.meta.url));

export class EventViewerPlugin implements Plugin {
  name = "event-viewer";
  description = "Web UI event viewer via HTTP + WebSocket";
  capabilities: string[] = ["web", "websocket"];

  private bus: EventBus | null = null;
  private server: ReturnType<typeof Bun.serve> | null = null;
  private wsClients: Set<ServerWebSocket<{ id: string }>> = new Set();
  private subscriptionId: string | null = null;
  private port: number;
  private viewerDir: string;
  private workspaceDir: string;

  constructor(port: number = 8080) {
    this.port = port;
    this.viewerDir = resolve(__dirname, "../../src/viewer");
    this.workspaceDir = resolve(process.env.WORKSPACE_DIR || join(process.cwd(), "workspace"));
  }

  install(bus: EventBus): void {
    this.bus = bus;

    this.subscriptionId = bus.subscribe("#", this.name, (msg: BusMessage) => {
      this.broadcast(msg);
    });

    this.server = Bun.serve({
      port: this.port,
      fetch: (req, server) => {
        const url = new URL(req.url);

        if (url.pathname === "/ws") {
          const upgraded = server.upgrade<{ id: string }>(req, {
            data: { id: crypto.randomUUID() },
          });
          if (upgraded) return undefined;
          return new Response("WebSocket upgrade failed", { status: 400 });
        }

        if (url.pathname === "/api/events") return this.handleApiEvents(req);
        if (url.pathname === "/api/topics") return this.handleApiTopics();
        if (url.pathname === "/api/consumers") return this.handleApiConsumers();
        if (url.pathname === "/api/projects") return this.handleApiProjects();
        if (url.pathname === "/api/agents") return this.handleApiAgents();

        return this.serveStatic(url.pathname);
      },
      websocket: {
        open: (ws) => {
          this.wsClients.add(ws);
        },
        message: () => {},
        close: (ws) => {
          this.wsClients.delete(ws);
        },
      },
    });

    console.log(`Event viewer available at http://localhost:${this.port}`);
  }

  uninstall(): void {
    if (this.server) {
      this.server.stop();
      this.server = null;
    }
    this.wsClients.clear();
  }

  private broadcast(msg: BusMessage): void {
    const data = JSON.stringify(msg);
    for (const ws of this.wsClients) {
      ws.send(data);
    }
  }

  private handleApiEvents(req: Request): Response {
    const url = new URL(req.url);
    const topic = url.searchParams.get("topic");
    const limit = parseInt(url.searchParams.get("limit") || "100", 10);
    const dataDir = process.env.DATA_DIR || resolve(process.cwd(), "data");
    const { Database } = require("bun:sqlite");
    const db = new Database(`${dataDir}/events.db`, { readonly: true });

    let rows: { payload: string }[];
    if (topic) {
      rows = db
        .query(
          "SELECT payload FROM events WHERE topic LIKE ? ORDER BY timestamp DESC LIMIT ?"
        )
        .all(`${topic}%`, limit) as { payload: string }[];
    } else {
      rows = db
        .query("SELECT payload FROM events ORDER BY timestamp DESC LIMIT ?")
        .all(limit) as { payload: string }[];
    }
    db.close();
    return Response.json(rows.map((r) => JSON.parse(r.payload)));
  }

  private handleApiTopics(): Response {
    return Response.json(this.bus?.topics() ?? []);
  }

  private handleApiConsumers(): Response {
    return Response.json(this.bus?.consumers() ?? []);
  }

  private handleApiProjects(): Response {
    return this._serveYaml("projects.yaml", "projects");
  }

  private handleApiAgents(): Response {
    return this._serveYaml("agents.yaml", "agents");
  }

  private _serveYaml(filename: string, key: string): Response {
    const filePath = join(this.workspaceDir, filename);
    if (!existsSync(filePath)) {
      return Response.json({ success: false, error: `${filename} not found` }, { status: 404 });
    }
    try {
      const raw = readFileSync(filePath, "utf8");
      const parsed = parseYaml(raw) as Record<string, unknown>;
      return Response.json({ success: true, data: parsed[key] ?? [] });
    } catch (err) {
      return Response.json({ success: false, error: `Failed to parse ${filename}` }, { status: 500 });
    }
  }

  private async serveStatic(pathname: string): Promise<Response> {
    if (pathname === "/" || pathname === "/index.html")
      return this.serveFile("index.html", "text/html");

    const safePath = pathname.replace(/\.\./g, "");
    const ext = safePath.split(".").pop()?.toLowerCase() || "";
    const mimes: Record<string, string> = {
      css: "text/css",
      js: "application/javascript",
      svg: "image/svg+xml",
      png: "image/png",
      ico: "image/x-icon",
    };
    return this.serveFile(safePath, mimes[ext] || "application/octet-stream");
  }

  private async serveFile(path: string, contentType: string): Promise<Response> {
    try {
      const file = Bun.file(resolve(this.viewerDir, path));
      if (await file.exists())
        return new Response(file, { headers: { "Content-Type": contentType } });
    } catch {}
    return new Response("Not found", { status: 404 });
  }
}
