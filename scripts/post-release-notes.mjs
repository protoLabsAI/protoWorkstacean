#!/usr/bin/env node
/**
 * post-release-notes.mjs — Rewrite commits with Claude and post to Discord.
 *
 * Usage:
 *   node scripts/post-release-notes.mjs [--from <ref>] [--to <ref>] [--title <string>] [--slug <project-slug>]
 *
 * Webhook resolution:
 *   Reads workspace/projects.yaml, finds the matching slug, reads discord.release.webhookEnv,
 *   then resolves process.env[webhookEnv] for the actual URL.
 *   Never reads webhook URLs from the YAML directly.
 *
 * Env vars:
 *   ANTHROPIC_API_KEY  — required (Claude Haiku for rewrite)
 *   <webhookEnv value> — e.g. DISCORD_WEBHOOK_PROTOWORKSTACEAN_RELEASE
 */

import { execSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { resolve, join, dirname } from "node:path";
import { parseArgs } from "node:util";
import { parse as parseYaml } from "yaml";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// ── Args ──────────────────────────────────────────────────────────────────────

const { values } = parseArgs({
  options: {
    from:  { type: "string" },
    to:    { type: "string", default: "HEAD" },
    title: { type: "string" },
    slug:  { type: "string", default: "protolabsai-protoworkstacean" },
  },
});

const to = values.to || "HEAD";

// ── Webhook resolution ────────────────────────────────────────────────────────

function resolveWebhook(slug) {
  const projectsPath = join(REPO_ROOT, "workspace", "projects.yaml");
  if (!existsSync(projectsPath)) return null;
  try {
    const parsed = parseYaml(readFileSync(projectsPath, "utf8"));
    const project = (parsed.projects ?? []).find(p => p.slug === slug);
    const envVar = project?.discord?.release?.webhookEnv;
    if (!envVar) { console.warn(`No webhookEnv configured for ${slug}`); return null; }
    const url = process.env[envVar];
    if (!url) { console.warn(`${envVar} is not set`); return null; }
    return url;
  } catch (err) {
    console.error("Failed to read projects.yaml:", err.message);
    return null;
  }
}

// ── Commits ───────────────────────────────────────────────────────────────────

let from = values.from;
if (!from) {
  try {
    from = execSync("git describe --tags --abbrev=0 HEAD^", { encoding: "utf8" }).trim();
    console.log(`Auto-detected range: ${from}..${to}`);
  } catch {
    from = execSync("git rev-list --max-count=30 HEAD | tail -1", { encoding: "utf8" }).trim();
    console.log("No previous tag found — using last 30 commits");
  }
}

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
if (notes.length > 3900) notes = notes.slice(0, 3897) + "…";

// ── Discord post ──────────────────────────────────────────────────────────────

const webhookUrl = resolveWebhook(values.slug);
if (!webhookUrl) {
  console.log("No webhook resolved — release notes preview:\n\n" + notes);
  process.exit(0);
}

const embed = {
  title: `protoWorkstacean ${version}`,
  description: notes,
  color: 0x7c3aed,
  timestamp: new Date().toISOString(),
  footer: { text: "protoWorkstacean" },
};

const discordResp = await fetch(webhookUrl, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ embeds: [embed] }),
});

if (!discordResp.ok) {
  console.error(`Discord post failed (${discordResp.status}): ${await discordResp.text()}`);
  process.exit(1);
}

console.log(`Posted release notes for ${version} to Discord.`);
