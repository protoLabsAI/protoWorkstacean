#!/usr/bin/env node
/**
 * post-release-notes.mjs — Rewrite commits with Claude and post to Discord.
 *
 * Usage:
 *   node scripts/post-release-notes.mjs [--from <ref>] [--to <ref>] [--title <string>]
 *
 * Env vars:
 *   ANTHROPIC_API_KEY        — required (Claude Haiku for rewrite)
 *   DISCORD_RELEASE_WEBHOOK  — required (Discord webhook URL)
 *
 * If --from is omitted, auto-detects the previous git tag.
 * If no tags exist, falls back to the last 30 commits.
 */

import { execSync } from "node:child_process";
import { parseArgs } from "node:util";

// ── Args ──────────────────────────────────────────────────────────────────────

const { values } = parseArgs({
  options: {
    from:  { type: "string" },
    to:    { type: "string", default: "HEAD" },
    title: { type: "string" },
  },
});

const to = values.to || "HEAD";

let from = values.from;
if (!from) {
  try {
    // Previous tag (one before HEAD so we don't include the tag commit itself)
    from = execSync("git describe --tags --abbrev=0 HEAD^", { encoding: "utf8" }).trim();
    console.log(`Auto-detected range: ${from}..${to}`);
  } catch {
    // No previous tag — grab last 30 commits
    from = execSync("git rev-list --max-count=30 HEAD | tail -1", { encoding: "utf8" }).trim();
    console.log(`No previous tag found — using last 30 commits`);
  }
}

// ── Commits ───────────────────────────────────────────────────────────────────

const rawLog = execSync(
  `git log ${from}..${to} --pretty=format:"%s" --no-merges`,
  { encoding: "utf8" },
).trim();

const NOISE = /^(chore: release|Merge |promote:|docs: session handoff|Co-Authored)/i;

const commits = rawLog
  .split("\n")
  .map(l => l.trim())
  .filter(l => l.length > 0 && !NOISE.test(l));

if (commits.length === 0) {
  console.log("No notable commits in range — nothing to post.");
  process.exit(0);
}

console.log(`${commits.length} commits to summarise.`);

// ── Version / title ───────────────────────────────────────────────────────────

let version = values.title;
if (!version) {
  try {
    version = execSync("git describe --tags", { encoding: "utf8" }).trim();
  } catch {
    version = execSync("git rev-parse --short HEAD", { encoding: "utf8" }).trim();
  }
}

// ── Claude rewrite ────────────────────────────────────────────────────────────

const apiKey = process.env.ANTHROPIC_API_KEY;
if (!apiKey) {
  console.error("ANTHROPIC_API_KEY not set");
  process.exit(1);
}

const SYSTEM_PROMPT = `\
You are writing release notes for protoWorkstacean — an autonomous multi-agent orchestration engine \
built on a typed event bus, YAML-driven world state, and a GOAP planner.

Given raw git commit subjects, rewrite them as polished release notes.

Rules:
- Group into 2–4 themed sections relevant to: World Engine, Plugins, HTTP API, Bug Fixes
- Each item is one sentence, present tense, outcome-focused (what it enables, not what changed)
- Skip purely internal housekeeping (fixture edits, comment typos, test data only)
- Use • for bullets. Use **Section Title** for headers. No emojis.
- Max 280 words. Plain markdown only — no code blocks, no headers with ##.`;

const resp = await fetch("https://api.anthropic.com/v1/messages", {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    "x-api-key": apiKey,
    "anthropic-version": "2023-06-01",
  },
  body: JSON.stringify({
    model: "claude-haiku-4-5-20251001",
    max_tokens: 700,
    system: SYSTEM_PROMPT,
    messages: [{ role: "user", content: commits.join("\n") }],
  }),
});

if (!resp.ok) {
  console.error(`Claude API error: ${resp.status}`, await resp.text());
  process.exit(1);
}

const data = await resp.json();
let notes = data.content?.[0]?.text ?? commits.map(c => `• ${c}`).join("\n");

// Discord embed description limit
if (notes.length > 3900) notes = notes.slice(0, 3897) + "…";

// ── Discord post ──────────────────────────────────────────────────────────────

const webhookUrl = process.env.DISCORD_RELEASE_WEBHOOK;
if (!webhookUrl) {
  console.log("DISCORD_RELEASE_WEBHOOK not set — release notes preview:\n\n" + notes);
  process.exit(0);
}

const embed = {
  title: `protoWorkstacean ${version}`,
  description: notes,
  color: 0x7c3aed,  // protoLabs purple
  timestamp: new Date().toISOString(),
  footer: { text: "protoWorkstacean" },
};

const discordResp = await fetch(webhookUrl, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ embeds: [embed] }),
});

if (!discordResp.ok) {
  const body = await discordResp.text();
  console.error(`Discord post failed (${discordResp.status}): ${body}`);
  process.exit(1);
}

console.log(`Posted release notes for ${version} to Discord.`);
