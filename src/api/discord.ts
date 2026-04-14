/**
 * Discord operations API — exposes Discord server management via HTTP.
 *
 * Backing routes for protoBot's DeepAgent tools. The DiscordPlugin holds
 * the Client reference; these routes find it in the plugin list and call
 * Discord.js methods through it.
 *
 * Routes:
 *   GET  /api/discord/server-stats      — member count, channel count, boost level
 *   GET  /api/discord/channels          — list all channels with type and category
 *   POST /api/discord/channels/create   — create a channel (text/voice/category)
 *   POST /api/discord/send              — send a message to a channel
 *   GET  /api/discord/members           — list members (paginated)
 *   GET  /api/discord/webhooks          — list webhooks across guild channels
 *   POST /api/discord/webhooks/create   — create a webhook on a channel
 *   POST /api/discord/react             — react to the message that triggered a conversation
 *   POST /api/discord/progress          — send a progress update during a running conversation
 */

import type { Route, ApiContext } from "./types.ts";
import { pendingReplies, canSendProgress } from "../../lib/plugins/discord.ts";

function getDiscordClient(ctx: ApiContext) {
  const plugin = ctx.plugins.find(p => p.name === "discord") as any;
  return plugin?.client ?? null;
}

function getGuildId(): string {
  return process.env.DISCORD_GUILD_ID ?? "";
}

export function createRoutes(ctx: ApiContext): Route[] {
  return [
    {
      method: "GET",
      path: "/api/discord/server-stats",
      handler: async () => {
        const client = getDiscordClient(ctx);
        if (!client) return Response.json({ success: false, error: "Discord not connected" }, { status: 503 });

        const guild = client.guilds.cache.get(getGuildId());
        if (!guild) return Response.json({ success: false, error: "Guild not found" }, { status: 404 });

        return Response.json({
          success: true,
          data: {
            name: guild.name,
            memberCount: guild.memberCount,
            channelCount: guild.channels.cache.size,
            roleCount: guild.roles.cache.size,
            boostLevel: guild.premiumTier,
            boostCount: guild.premiumSubscriptionCount,
            createdAt: guild.createdAt.toISOString(),
          },
        });
      },
    },
    {
      method: "GET",
      path: "/api/discord/channels",
      handler: async () => {
        const client = getDiscordClient(ctx);
        if (!client) return Response.json({ success: false, error: "Discord not connected" }, { status: 503 });

        const guild = client.guilds.cache.get(getGuildId());
        if (!guild) return Response.json({ success: false, error: "Guild not found" }, { status: 404 });

        const channels = guild.channels.cache.map((ch: any) => ({
          id: ch.id,
          name: ch.name,
          type: ch.type,
          parentId: ch.parentId,
          parentName: ch.parent?.name ?? null,
          position: ch.position,
        }));

        return Response.json({ success: true, data: channels });
      },
    },
    {
      method: "POST",
      path: "/api/discord/channels/create",
      handler: async (req) => {
        const client = getDiscordClient(ctx);
        if (!client) return Response.json({ success: false, error: "Discord not connected" }, { status: 503 });

        const guild = client.guilds.cache.get(getGuildId());
        if (!guild) return Response.json({ success: false, error: "Guild not found" }, { status: 404 });

        let body: { name?: string; type?: string; parent?: string; topic?: string };
        try { body = await req.json() as typeof body; }
        catch { return Response.json({ success: false, error: "Invalid JSON" }, { status: 400 }); }

        if (!body.name) return Response.json({ success: false, error: "name is required" }, { status: 400 });

        // Map friendly type names to Discord.js ChannelType values
        const typeMap: Record<string, number> = { text: 0, voice: 2, category: 4, announcement: 5, forum: 15 };
        const channelType = typeMap[body.type ?? "text"] ?? 0;

        try {
          const options: any = { name: body.name, type: channelType };
          if (body.parent) {
            const parent = guild.channels.cache.find((ch: any) => ch.name === body.parent || ch.id === body.parent);
            if (parent) options.parent = parent.id;
          }
          if (body.topic) options.topic = body.topic;

          const created = await guild.channels.create(options);
          return Response.json({
            success: true,
            data: { id: created.id, name: created.name, type: created.type },
          });
        } catch (e) {
          return Response.json({ success: false, error: e instanceof Error ? e.message : String(e) }, { status: 500 });
        }
      },
    },
    {
      method: "POST",
      path: "/api/discord/send",
      handler: async (req) => {
        const client = getDiscordClient(ctx);
        if (!client) return Response.json({ success: false, error: "Discord not connected" }, { status: 503 });

        let body: { channelId?: string; channelName?: string; content?: string };
        try { body = await req.json() as typeof body; }
        catch { return Response.json({ success: false, error: "Invalid JSON" }, { status: 400 }); }

        if (!body.content) return Response.json({ success: false, error: "content is required" }, { status: 400 });

        const guild = client.guilds.cache.get(getGuildId());
        let channel: any = null;

        if (body.channelId) {
          channel = client.channels.cache.get(body.channelId);
        } else if (body.channelName && guild) {
          channel = guild.channels.cache.find((ch: any) => ch.name === body.channelName);
        }

        if (!channel?.send) return Response.json({ success: false, error: "Channel not found or not text-based" }, { status: 404 });

        try {
          const msg = await channel.send({ content: body.content });
          return Response.json({ success: true, data: { messageId: msg.id, channelId: channel.id } });
        } catch (e) {
          return Response.json({ success: false, error: e instanceof Error ? e.message : String(e) }, { status: 500 });
        }
      },
    },
    {
      method: "GET",
      path: "/api/discord/members",
      handler: async () => {
        const client = getDiscordClient(ctx);
        if (!client) return Response.json({ success: false, error: "Discord not connected" }, { status: 503 });

        const guild = client.guilds.cache.get(getGuildId());
        if (!guild) return Response.json({ success: false, error: "Guild not found" }, { status: 404 });

        // Use cached members (no API fetch — respects rate limits)
        const members = guild.members.cache.map((m: any) => ({
          id: m.id,
          username: m.user.username,
          displayName: m.displayName,
          bot: m.user.bot,
          roles: m.roles.cache.filter((r: any) => r.name !== "@everyone").map((r: any) => r.name),
          joinedAt: m.joinedAt?.toISOString() ?? null,
        }));

        return Response.json({ success: true, data: members });
      },
    },
    {
      method: "GET",
      path: "/api/discord/webhooks",
      handler: async () => {
        const client = getDiscordClient(ctx);
        if (!client) return Response.json({ success: false, error: "Discord not connected" }, { status: 503 });

        const guild = client.guilds.cache.get(getGuildId());
        if (!guild) return Response.json({ success: false, error: "Guild not found" }, { status: 404 });

        try {
          const hooks = await guild.fetchWebhooks();
          const data = hooks.map((w: any) => ({
            id: w.id,
            name: w.name,
            channelId: w.channelId,
            url: w.url,
            owner: w.owner?.username ?? null,
          }));
          return Response.json({ success: true, data });
        } catch (e) {
          return Response.json({ success: false, error: e instanceof Error ? e.message : String(e) }, { status: 500 });
        }
      },
    },
    {
      method: "POST",
      path: "/api/discord/webhooks/create",
      handler: async (req) => {
        const client = getDiscordClient(ctx);
        if (!client) return Response.json({ success: false, error: "Discord not connected" }, { status: 503 });

        const guild = client.guilds.cache.get(getGuildId());
        if (!guild) return Response.json({ success: false, error: "Guild not found" }, { status: 404 });

        let body: { channelId?: string; channelName?: string; name?: string; reason?: string };
        try { body = await req.json() as typeof body; }
        catch { return Response.json({ success: false, error: "Invalid JSON" }, { status: 400 }); }

        if (!body.name) return Response.json({ success: false, error: "name is required" }, { status: 400 });

        let channel: any = null;
        if (body.channelId) {
          channel = guild.channels.cache.get(body.channelId);
        } else if (body.channelName) {
          channel = guild.channels.cache.find((ch: any) => ch.name === body.channelName);
        }
        if (!channel) return Response.json({ success: false, error: "Channel not found (pass channelId or channelName)" }, { status: 404 });
        if (typeof channel.createWebhook !== "function") {
          return Response.json({ success: false, error: "Channel type does not support webhooks" }, { status: 400 });
        }

        try {
          const hook = await channel.createWebhook({ name: body.name, reason: body.reason });
          return Response.json({
            success: true,
            data: { id: hook.id, name: hook.name, channelId: hook.channelId, url: hook.url },
          });
        } catch (e) {
          return Response.json({ success: false, error: e instanceof Error ? e.message : String(e) }, { status: 500 });
        }
      },
    },
    {
      method: "POST",
      path: "/api/discord/react",
      handler: async (req) => {
        let body: { correlationId?: string; emoji?: string };
        try { body = (await req.json()) as typeof body; }
        catch { return Response.json({ success: false, error: "Invalid JSON" }, { status: 400 }); }

        if (!body.correlationId || !body.emoji) {
          return Response.json({ success: false, error: "correlationId and emoji are required" }, { status: 400 });
        }

        const pending = pendingReplies.get(body.correlationId);
        if (!pending?.message) {
          return Response.json({ success: false, error: "No pending message for this correlationId" }, { status: 404 });
        }

        try {
          await pending.message.react(body.emoji);
          return Response.json({ success: true });
        } catch (e) {
          return Response.json({ success: false, error: e instanceof Error ? e.message : String(e) }, { status: 500 });
        }
      },
    },
    {
      method: "POST",
      path: "/api/discord/progress",
      handler: async (req) => {
        let body: { correlationId?: string; content?: string };
        try { body = (await req.json()) as typeof body; }
        catch { return Response.json({ success: false, error: "Invalid JSON" }, { status: 400 }); }

        if (!body.correlationId || !body.content) {
          return Response.json({ success: false, error: "correlationId and content are required" }, { status: 400 });
        }

        // Server-side throttle — 1 update per 5s per conversation
        if (!canSendProgress(body.correlationId)) {
          return Response.json({ success: false, error: "Throttled — last update was < 5s ago", throttled: true }, { status: 429 });
        }

        const pending = pendingReplies.get(body.correlationId);
        if (!pending?.message) {
          return Response.json({ success: false, error: "No pending message for this correlationId" }, { status: 404 });
        }

        try {
          await (pending.message.channel as any).send({ content: body.content.slice(0, 2000) });
          return Response.json({ success: true });
        } catch (e) {
          return Response.json({ success: false, error: e instanceof Error ? e.message : String(e) }, { status: 500 });
        }
      },
    },
  ];
}
