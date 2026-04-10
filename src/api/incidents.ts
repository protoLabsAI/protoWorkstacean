/**
 * Incident management routes — report, resolve, query, security summary.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import type { Route, ApiContext } from "./types.ts";
import { serveWorkspaceYaml } from "./types.ts";

interface SecurityIncident {
  id: string;
  title: string;
  severity: "critical" | "high" | "medium" | "low";
  status: "open" | "investigating" | "resolved";
  reportedAt: string;
  description?: string;
  affectedProjects?: string[];
  assignee?: string;
}

export function createRoutes(ctx: ApiContext): Route[] {

  function handleGetIncidents(): Response {
    return serveWorkspaceYaml(ctx.workspaceDir, "incidents.yaml", "incidents");
  }

  function handleGetSecuritySummary(): Response {
    const filePath = join(ctx.workspaceDir, "incidents.yaml");
    if (!existsSync(filePath)) return Response.json({ openCount: 0, criticalCount: 0, incidents: [] });
    try {
      const parsed = parseYaml(readFileSync(filePath, "utf8")) as { incidents?: SecurityIncident[] };
      const incidents = parsed.incidents ?? [];
      const open = incidents.filter(i => i.status !== "resolved");
      const critical = open.filter(i => i.severity === "critical");
      return Response.json({
        openCount: open.length,
        criticalCount: critical.length,
        incidents: open.map(i => ({ id: i.id, title: i.title, severity: i.severity, status: i.status })),
      });
    } catch {
      return Response.json({ openCount: 0, criticalCount: 0, incidents: [] });
    }
  }

  async function handleReportIncident(req: Request): Promise<Response> {
    if (ctx.apiKey && req.headers.get("X-API-Key") !== ctx.apiKey) {
      return Response.json({ success: false, error: "Unauthorized" }, { status: 401 });
    }

    let body: Record<string, unknown>;
    try { body = (await req.json()) as Record<string, unknown>; }
    catch { return Response.json({ success: false, error: "Invalid JSON body" }, { status: 400 }); }

    if (!body.title || !body.severity) {
      return Response.json({ success: false, error: "Missing required fields: title, severity" }, { status: 400 });
    }

    const incidentsPath = join(ctx.workspaceDir, "incidents.yaml");
    let existing: SecurityIncident[] = [];
    if (existsSync(incidentsPath)) {
      try {
        const parsed = parseYaml(readFileSync(incidentsPath, "utf8")) as { incidents?: SecurityIncident[] };
        existing = parsed.incidents ?? [];
      } catch { /* start fresh */ }
    }

    const incident: SecurityIncident = {
      id: `INC-${String(existing.length + 1).padStart(3, "0")}`,
      title: body.title as string,
      severity: body.severity as SecurityIncident["severity"],
      status: (body.status as SecurityIncident["status"]) ?? "open",
      reportedAt: new Date().toISOString(),
      ...(body.description ? { description: body.description as string } : {}),
      ...(Array.isArray(body.affectedProjects) ? { affectedProjects: body.affectedProjects as string[] } : {}),
      ...(body.assignee ? { assignee: body.assignee as string } : {}),
    };

    existing.push(incident);
    writeFileSync(incidentsPath, stringifyYaml({ incidents: existing }), "utf8");

    ctx.bus.publish("security.incident.reported", {
      id: crypto.randomUUID(),
      correlationId: crypto.randomUUID(),
      topic: "security.incident.reported",
      timestamp: Date.now(),
      payload: { incident },
    });

    return Response.json({ success: true, data: incident }, { status: 201 });
  }

  async function handleResolveIncident(req: Request, incidentId: string): Promise<Response> {
    if (ctx.apiKey && req.headers.get("X-API-Key") !== ctx.apiKey) {
      return Response.json({ success: false, error: "Unauthorized" }, { status: 401 });
    }

    const incidentsPath = join(ctx.workspaceDir, "incidents.yaml");
    if (!existsSync(incidentsPath)) {
      return Response.json({ success: false, error: "No incidents file found" }, { status: 404 });
    }

    let incidents: SecurityIncident[];
    try {
      const parsed = parseYaml(readFileSync(incidentsPath, "utf8")) as { incidents?: SecurityIncident[] };
      incidents = parsed.incidents ?? [];
    } catch {
      return Response.json({ success: false, error: "Failed to parse incidents.yaml" }, { status: 500 });
    }

    const idx = incidents.findIndex(i => i.id === incidentId);
    if (idx === -1) {
      return Response.json({ success: false, error: `Incident "${incidentId}" not found` }, { status: 404 });
    }

    incidents[idx] = { ...incidents[idx], status: "resolved" };
    writeFileSync(incidentsPath, stringifyYaml({ incidents }), "utf8");

    ctx.bus.publish("security.incident.reported", {
      id: crypto.randomUUID(),
      correlationId: crypto.randomUUID(),
      topic: "security.incident.reported",
      timestamp: Date.now(),
      payload: { incident: incidents[idx] },
    });

    return Response.json({ success: true, data: incidents[idx] });
  }

  return [
    { method: "GET",  path: "/api/incidents",             handler: () => handleGetIncidents() },
    { method: "GET",  path: "/api/security-summary",      handler: () => handleGetSecuritySummary() },
    { method: "POST", path: "/api/incidents",             handler: (req) => handleReportIncident(req) },
    { method: "POST", path: "/api/incidents/:id/resolve", handler: (req, p) => handleResolveIncident(req, p.id) },
  ];
}
