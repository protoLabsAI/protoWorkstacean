/**
 * Linear API routes — back the Ava-side tools that read the Linear board on
 * demand and (optionally) file issues / post comments.
 *
 * Endpoints:
 *   GET  /api/linear/teams
 *   GET  /api/linear/issues?team=&state=&label=&assignee=me&max=
 *   GET  /api/linear/issues/search?q=&max=
 *   GET  /api/linear/issues/:idOrKey
 *   POST /api/linear/issues                   { teamKey, title, description?, priority?, labelIds?, stateName? }
 *   POST /api/linear/issues/:id/comment       { body }
 *
 * Every endpoint requires LINEAR_API_KEY. Without it, returns 503 with a
 * clear "linear plugin disabled" message so Ava's tool layer surfaces the
 * gap rather than crashing.
 */

import type { Route, ApiContext } from "./types.ts";
import { LinearClient, type LinearPriority } from "../../lib/linear-client.ts";

let cachedClient: LinearClient | null = null;
function getClient(): LinearClient | null {
  const key = process.env.LINEAR_API_KEY;
  if (!key) return null;
  if (!cachedClient) cachedClient = new LinearClient(key);
  return cachedClient;
}

function disabledResponse(): Response {
  return Response.json(
    { success: false, error: "Linear plugin disabled — LINEAR_API_KEY env var is required." },
    { status: 503 },
  );
}

async function withClient<T>(handler: (c: LinearClient) => Promise<T>): Promise<Response> {
  const client = getClient();
  if (!client) return disabledResponse();
  try {
    const data = await handler(client);
    return Response.json({ success: true, data });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return Response.json({ success: false, error: msg }, { status: 500 });
  }
}

const VALID_PRIORITIES: ReadonlySet<LinearPriority> = new Set(["urgent", "high", "medium", "low", "none"]);

export function createRoutes(_ctx: ApiContext): Route[] {
  return [
    {
      method: "GET",
      path: "/api/linear/teams",
      handler: () => withClient(async (c) => {
        const teams = await c.listTeams();
        return { count: teams.length, teams };
      }),
    },

    {
      method: "GET",
      path: "/api/linear/issues",
      handler: (req) => {
        const url = new URL(req.url);
        const team = url.searchParams.get("team") ?? undefined;
        const state = url.searchParams.get("state") ?? undefined;
        const label = url.searchParams.get("label") ?? undefined;
        const assignee = url.searchParams.get("assignee");
        const max = Math.min(parseInt(url.searchParams.get("max") ?? "50", 10) || 50, 250);
        return withClient(async (c) => {
          const issues = await c.listIssues({
            teamKey: team,
            state,
            label,
            assignedToMe: assignee === "me",
            max,
          });
          return { count: issues.length, filter: { team, state, label, assignee, max }, issues };
        });
      },
    },

    {
      method: "GET",
      path: "/api/linear/issues/search",
      handler: (req) => {
        const url = new URL(req.url);
        const q = url.searchParams.get("q") ?? "";
        const max = Math.min(parseInt(url.searchParams.get("max") ?? "25", 10) || 25, 100);
        if (!q.trim()) {
          return Promise.resolve(Response.json({ success: false, error: "missing q parameter" }, { status: 400 }));
        }
        return withClient(async (c) => {
          const issues = await c.searchIssues(q, max);
          return { query: q, count: issues.length, issues };
        });
      },
    },

    {
      method: "GET",
      path: "/api/linear/issues/:idOrKey",
      handler: (_req, params) => {
        const idOrKey = params?.idOrKey;
        if (!idOrKey) {
          return Promise.resolve(Response.json({ success: false, error: "missing idOrKey" }, { status: 400 }));
        }
        return withClient(async (c) => {
          const issue = await c.getIssue(idOrKey);
          if (!issue) throw new Error(`issue ${idOrKey} not found`);
          return issue;
        });
      },
    },

    {
      method: "POST",
      path: "/api/linear/issues",
      handler: async (req) => {
        let input: {
          teamKey?: string;
          title?: string;
          description?: string;
          priority?: string;
          labelIds?: string[];
          stateName?: string;
        };
        try {
          input = await req.json() as typeof input;
        } catch {
          return Response.json({ success: false, error: "invalid JSON body" }, { status: 400 });
        }
        if (!input.teamKey || !input.title) {
          return Response.json({ success: false, error: "teamKey and title are required" }, { status: 400 });
        }
        if (input.priority && !VALID_PRIORITIES.has(input.priority as LinearPriority)) {
          return Response.json({ success: false, error: `invalid priority — must be one of urgent/high/medium/low/none` }, { status: 400 });
        }
        return withClient(async (c) => {
          const id = await c.createIssue({
            teamKey: input.teamKey!,
            title: input.title!,
            description: input.description,
            priority: input.priority as LinearPriority | undefined,
            labelIds: input.labelIds,
            stateName: input.stateName,
          });
          if (!id) throw new Error(`createIssue failed — team key '${input.teamKey}' may not exist`);
          return { id, teamKey: input.teamKey, title: input.title };
        });
      },
    },

    {
      method: "POST",
      path: "/api/linear/issues/:id/comment",
      handler: async (req, params) => {
        const id = params?.id;
        if (!id) return Response.json({ success: false, error: "missing id" }, { status: 400 });
        let input: { body?: string };
        try {
          input = await req.json() as typeof input;
        } catch {
          return Response.json({ success: false, error: "invalid JSON body" }, { status: 400 });
        }
        if (!input.body?.trim()) {
          return Response.json({ success: false, error: "missing body" }, { status: 400 });
        }
        return withClient(async (c) => {
          const ok = await c.addComment(id, input.body!);
          if (!ok) throw new Error("addComment returned false");
          return { issueId: id, posted: true };
        });
      },
    },
  ];
}
