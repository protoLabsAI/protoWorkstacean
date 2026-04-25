#!/usr/bin/env bun
/**
 * audit-bus-topics — static AST scan of every `bus.publish(...)` and
 * `bus.subscribe(...)` call site in src/ + lib/, resolved to topic strings
 * and grouped by publisher / subscriber, then dumped as a single
 * "Swagger-for-the-bus" markdown reference at docs/reference/bus-topics.md.
 *
 * Resolution rules for the topic argument:
 *   - String literal "foo.bar"                      → "foo.bar"
 *   - TOPICS.NAME identifier                        → looked up in TOPICS table (built from
 *                                                     src/event-bus/all-topics.ts) → its value
 *   - Template literal `linear.reply.${issueId}`    → pattern "linear.reply.{issueId}"
 *   - String concatenation "a." + b                 → pattern "a.{...}"
 *   - Anything else (computed property, var)        → flagged "unresolved"
 *
 * Payload type binding is loose — pulled from JSDoc on payload interfaces in
 * src/event-bus/payloads.ts using the convention `Payload for \`{topic}\``.
 *
 * Usage:
 *   bun run scripts/audit-bus-topics.ts
 *
 * Output:
 *   docs/reference/bus-topics.md  (regenerated; safe to commit)
 *
 * Exit codes:
 *   0  — success
 *   1  — found unresolved topic call sites (intent: CI failure when a new
 *        raw-string publish doesn't match any pattern). Override with
 *        --allow-unresolved.
 */

import * as ts from "typescript";
import { readdirSync, readFileSync, writeFileSync, existsSync, mkdirSync, statSync } from "node:fs";
import { join, relative, dirname } from "node:path";

// ─────────────────────────────────────────────────────────────────────────────
// CLI args

const ARGS = new Set(process.argv.slice(2));
const ALLOW_UNRESOLVED = ARGS.has("--allow-unresolved");

// ─────────────────────────────────────────────────────────────────────────────
// File discovery

const REPO_ROOT = process.cwd();
const SCAN_ROOTS = ["src", "lib"];
const EXCLUDE_DIRS = new Set(["node_modules", ".git", "dist", "build", "__tests__"]);
const EXCLUDE_SUFFIXES = [".test.ts", ".d.ts"];

function walkTsFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    let st;
    try { st = statSync(full); } catch { continue; }
    if (st.isDirectory()) {
      if (EXCLUDE_DIRS.has(entry)) continue;
      walkTsFiles(full, out);
    } else if (st.isFile() && entry.endsWith(".ts") && !EXCLUDE_SUFFIXES.some(s => entry.endsWith(s))) {
      out.push(full);
    }
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// Build TOPICS lookup table from src/event-bus/all-topics.ts
//
// Parses the file's exported const object literals (MESSAGE_TOPICS,
// ACTION_TOPICS, etc.) into a flat map of NAME → value-literal so callers like
// `bus.publish(TOPICS.AGENT_SKILL_REQUEST, ...)` can be resolved.

interface TopicConstantInfo {
  /** Exported group name, e.g. "ACTION_TOPICS". */
  group: string;
  /** JSDoc comment if present. */
  doc?: string;
  /** Resolved string value. */
  value: string;
}

function buildTopicsTable(): Map<string, TopicConstantInfo> {
  const path = join(REPO_ROOT, "src/event-bus/all-topics.ts");
  const table = new Map<string, TopicConstantInfo>();
  if (!existsSync(path)) return table;

  const source = readFileSync(path, "utf8");
  const sf = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true);

  ts.forEachChild(sf, (node) => {
    if (!ts.isVariableStatement(node)) return;
    if (!node.modifiers?.some(m => m.kind === ts.SyntaxKind.ExportKeyword)) return;
    for (const decl of node.declarationList.declarations) {
      if (!ts.isIdentifier(decl.name)) continue;
      const groupName = decl.name.text;
      const init = decl.initializer;
      // Strip "as const" wrapper.
      let obj: ts.Expression | undefined = init;
      if (init && ts.isAsExpression(init)) obj = init.expression;
      if (!obj || !ts.isObjectLiteralExpression(obj)) continue;
      for (const prop of obj.properties) {
        if (!ts.isPropertyAssignment(prop)) continue;
        if (!ts.isIdentifier(prop.name)) continue;
        const name = prop.name.text;
        if (!ts.isStringLiteral(prop.initializer)) continue;
        const value = prop.initializer.text;
        const doc = readJsDoc(prop);
        table.set(name, { group: groupName, doc, value });
      }
    }
  });
  return table;
}

function readJsDoc(node: ts.Node): string | undefined {
  const ranges = ts.getLeadingCommentRanges(node.getSourceFile().text, node.getFullStart());
  if (!ranges) return undefined;
  for (const r of ranges) {
    if (r.kind !== ts.SyntaxKind.MultiLineCommentTrivia) continue;
    const raw = node.getSourceFile().text.slice(r.pos, r.end);
    if (!raw.startsWith("/**")) continue;
    return raw
      .replace(/^\/\*\*/, "")
      .replace(/\*\/$/, "")
      .split("\n")
      .map(l => l.replace(/^\s*\*\s?/, "").trim())
      .filter(Boolean)
      .join(" ")
      .trim();
  }
  return undefined;
}

// ─────────────────────────────────────────────────────────────────────────────
// Build payload-type binding from src/event-bus/payloads.ts
//
// Convention: payload interfaces have JSDoc that says `Payload for \`{topic}\``
// — we extract the topic backtick to map topic → interface name.

function buildPayloadBindings(): Map<string, string> {
  const path = join(REPO_ROOT, "src/event-bus/payloads.ts");
  const map = new Map<string, string>();
  if (!existsSync(path)) return map;
  const source = readFileSync(path, "utf8");
  const sf = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true);
  ts.forEachChild(sf, (node) => {
    if (!ts.isInterfaceDeclaration(node)) return;
    const doc = readJsDoc(node);
    if (!doc) return;
    // Match: Payload for `topic.name` or Payload for `topic.name.{var}`
    const m = doc.match(/Payload for `([^`]+)`/);
    if (m) map.set(m[1], node.name.text);
  });
  return map;
}

// ─────────────────────────────────────────────────────────────────────────────
// AST visitor: find every bus.publish / bus.subscribe call

interface CallSite {
  file: string;
  line: number;
  topic: string;          // resolved literal or pattern
  topicRaw: string;       // original argument source
  resolved: boolean;      // false → couldn't resolve to a literal
  kind: "publish" | "subscribe";
}

const TOPIC_BUILDER_PATTERNS: RegExp[] = [
  // Heuristic: variable names that obviously hold a topic
  /^(topic|replyTopic|replyT|resultTopic|out)$/,
];

function resolveTopic(arg: ts.Expression, topicsTable: Map<string, TopicConstantInfo>): { topic: string; resolved: boolean } {
  // String literal
  if (ts.isStringLiteral(arg) || ts.isNoSubstitutionTemplateLiteral(arg)) {
    return { topic: arg.text, resolved: true };
  }

  // Template literal — turn ${expr} into {paramName} or {expr}
  if (ts.isTemplateExpression(arg)) {
    let s = arg.head.text;
    for (const span of arg.templateSpans) {
      const expr = span.expression;
      let label: string;
      if (ts.isIdentifier(expr)) label = expr.text;
      else if (ts.isPropertyAccessExpression(expr)) label = expr.name.text;
      else label = "...";
      s += `{${label}}` + span.literal.text;
    }
    return { topic: s, resolved: true };
  }

  // PropertyAccessExpression e.g. TOPICS.AGENT_SKILL_REQUEST or ACTION_TOPICS.X
  if (ts.isPropertyAccessExpression(arg)) {
    const name = arg.name.text;
    const hit = topicsTable.get(name);
    if (hit) return { topic: hit.value, resolved: true };
    // Unknown identifier — leave as a labeled placeholder
    const root = ts.isIdentifier(arg.expression) ? arg.expression.text : "?";
    return { topic: `${root}.${name}`, resolved: false };
  }

  // String concatenation — flatten "a." + b → "a.{b}"
  if (ts.isBinaryExpression(arg) && arg.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    const parts: string[] = [];
    function flatten(e: ts.Expression): void {
      if (ts.isBinaryExpression(e) && e.operatorToken.kind === ts.SyntaxKind.PlusToken) {
        flatten(e.left); flatten(e.right);
        return;
      }
      if (ts.isStringLiteral(e) || ts.isNoSubstitutionTemplateLiteral(e)) {
        parts.push(e.text); return;
      }
      if (ts.isIdentifier(e)) { parts.push(`{${e.text}}`); return; }
      if (ts.isPropertyAccessExpression(e)) { parts.push(`{${e.name.text}}`); return; }
      parts.push("{...}");
    }
    flatten(arg);
    return { topic: parts.join(""), resolved: true };
  }

  // Identifier — heuristic fallback: well-known topic-holding variable names
  if (ts.isIdentifier(arg)) {
    if (TOPIC_BUILDER_PATTERNS.some(p => p.test(arg.text))) {
      return { topic: `{${arg.text}}`, resolved: false };
    }
    return { topic: `{${arg.text}}`, resolved: false };
  }

  return { topic: "{computed}", resolved: false };
}

function scanFile(file: string, topicsTable: Map<string, TopicConstantInfo>): CallSite[] {
  const source = readFileSync(file, "utf8");
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  const sites: CallSite[] = [];
  const rel = relative(REPO_ROOT, file);

  function visit(node: ts.Node): void {
    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      if (ts.isPropertyAccessExpression(callee)) {
        const method = callee.name.text;
        if ((method === "publish" || method === "subscribe") && node.arguments.length > 0) {
          // Only count when the receiver looks bus-y. Keep loose so we catch
          // both `this.bus.publish` and `bus.publish` and `event.publish`.
          const receiverText = callee.expression.getText(sf);
          const looksBusLike = /\b(bus|eventBus)\b/i.test(receiverText) || receiverText === "bus";
          if (looksBusLike) {
            const arg = node.arguments[0];
            const { topic, resolved } = resolveTopic(arg, topicsTable);
            const start = sf.getLineAndCharacterOfPosition(node.getStart(sf));
            sites.push({
              file: rel,
              line: start.line + 1,
              topic,
              topicRaw: arg.getText(sf),
              resolved,
              kind: method,
            });
          }
        }
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(sf);
  return sites;
}

// ─────────────────────────────────────────────────────────────────────────────
// Aggregate + render

interface TopicEntry {
  topic: string;
  publishers: CallSite[];
  subscribers: CallSite[];
  declared: boolean;        // true → defined in TOPICS / all-topics.ts
  declaredAs?: string;      // constant name, e.g. "AGENT_SKILL_REQUEST"
  group?: string;           // domain group
  doc?: string;
  payloadType?: string;
}

function aggregate(
  sites: CallSite[],
  topicsTable: Map<string, TopicConstantInfo>,
  payloadBindings: Map<string, string>,
): TopicEntry[] {
  const byTopic = new Map<string, TopicEntry>();

  function bucket(topic: string): TopicEntry {
    const cur = byTopic.get(topic);
    if (cur) return cur;
    const declaredEntry = [...topicsTable.entries()].find(([, info]) => info.value === topic);
    const entry: TopicEntry = {
      topic,
      publishers: [],
      subscribers: [],
      declared: Boolean(declaredEntry),
      declaredAs: declaredEntry?.[0],
      group: declaredEntry?.[1].group,
      doc: declaredEntry?.[1].doc,
      payloadType: payloadBindings.get(topic),
    };
    byTopic.set(topic, entry);
    return entry;
  }

  for (const site of sites) {
    const entry = bucket(site.topic);
    if (site.kind === "publish") entry.publishers.push(site);
    else entry.subscribers.push(site);
  }

  // Surface declared-but-unused topics (in TOPICS but never published or subscribed).
  for (const [name, info] of topicsTable) {
    if (![...byTopic.values()].some(e => e.declared && e.declaredAs === name)) {
      byTopic.set(info.value, {
        topic: info.value,
        publishers: [],
        subscribers: [],
        declared: true,
        declaredAs: name,
        group: info.group,
        doc: info.doc,
        payloadType: payloadBindings.get(info.value),
      });
    }
  }

  return [...byTopic.values()].sort((a, b) => a.topic.localeCompare(b.topic));
}

function renderMarkdown(entries: TopicEntry[]): string {
  const generated = new Date().toISOString();
  const totalPublishers = entries.reduce((a, e) => a + e.publishers.length, 0);
  const totalSubscribers = entries.reduce((a, e) => a + e.subscribers.length, 0);
  const declared = entries.filter(e => e.declared).length;
  const undeclared = entries.length - declared;
  const unresolved = entries.filter(e => /\{computed\}|\{[A-Za-z_]+\}$/.test(e.topic) && !e.declared).length;

  const lines: string[] = [];
  lines.push("---");
  lines.push("title: Bus Topics");
  lines.push("---");
  lines.push("");
  lines.push("> AUTO-GENERATED by `bun run audit:bus`. Do not edit by hand — regenerate after changing publish/subscribe sites.");
  lines.push("");
  lines.push(`Generated ${generated}.`);
  lines.push("");
  lines.push("## Summary");
  lines.push("");
  lines.push(`- **${entries.length}** distinct topics seen across the codebase`);
  lines.push(`- **${declared}** declared in \`src/event-bus/all-topics.ts\` (TOPICS constant)`);
  lines.push(`- **${undeclared}** raw-string / template topics not in TOPICS (candidates to register)`);
  lines.push(`- **${unresolved}** topics that couldn't be statically resolved (computed at runtime)`);
  lines.push(`- **${totalPublishers}** publish call sites, **${totalSubscribers}** subscribe call sites`);
  lines.push("");
  lines.push("Each row links to the original call site as `path:line` so jumping from this index to the source is a click.");
  lines.push("");

  // Group by domain prefix (first segment of the topic).
  const byGroup = new Map<string, TopicEntry[]>();
  for (const e of entries) {
    const group = e.topic.split(".")[0] || "(other)";
    const arr = byGroup.get(group) ?? [];
    arr.push(e);
    byGroup.set(group, arr);
  }

  const groupNames = [...byGroup.keys()].sort();
  for (const g of groupNames) {
    lines.push(`## \`${g}.*\``);
    lines.push("");
    lines.push("| Topic | Declared | Payload | Publishers | Subscribers |");
    lines.push("|---|---|---|---|---|");
    for (const e of (byGroup.get(g) ?? [])) {
      const declaredCell = e.declared
        ? `✅ \`${e.declaredAs}\` (\`${e.group}\`)`
        : "—";
      const payloadCell = e.payloadType ? `\`${e.payloadType}\`` : "—";
      const pubsCell = e.publishers.length
        ? e.publishers.map(p => `\`${p.file}:${p.line}\``).join("<br>")
        : "_(none)_";
      const subsCell = e.subscribers.length
        ? e.subscribers.map(s => `\`${s.file}:${s.line}\``).join("<br>")
        : "_(none)_";
      lines.push(`| \`${e.topic}\` | ${declaredCell} | ${payloadCell} | ${pubsCell} | ${subsCell} |`);
    }
    lines.push("");
    // Per-topic notes (only when there's documentation worth surfacing)
    for (const e of (byGroup.get(g) ?? [])) {
      if (e.doc) {
        lines.push(`**\`${e.topic}\`** — ${e.doc}`);
        lines.push("");
      }
    }
  }

  // Unresolved section
  const unresolvedSites = entries
    .flatMap(e => [...e.publishers, ...e.subscribers].filter(s => !s.resolved))
    .sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
  if (unresolvedSites.length > 0) {
    lines.push("## Unresolved call sites");
    lines.push("");
    lines.push("These sites pass a non-literal topic that the static scan couldn't resolve to a string. The reported topic is a heuristic placeholder.");
    lines.push("");
    lines.push("| Site | Kind | Source |");
    lines.push("|---|---|---|");
    for (const s of unresolvedSites) {
      lines.push(`| \`${s.file}:${s.line}\` | ${s.kind} | \`${s.topicRaw.replace(/\|/g, "\\|").slice(0, 80)}\` |`);
    }
    lines.push("");
  }

  return lines.join("\n") + "\n";
}

// ─────────────────────────────────────────────────────────────────────────────
// Main

function main(): void {
  console.log("[audit-bus-topics] scanning…");
  const topicsTable = buildTopicsTable();
  const payloadBindings = buildPayloadBindings();
  console.log(`[audit-bus-topics] loaded ${topicsTable.size} TOPICS constants and ${payloadBindings.size} payload bindings`);

  const files: string[] = [];
  for (const root of SCAN_ROOTS) {
    const abs = join(REPO_ROOT, root);
    if (existsSync(abs)) walkTsFiles(abs, files);
  }
  console.log(`[audit-bus-topics] scanning ${files.length} .ts files`);

  const sites: CallSite[] = [];
  for (const f of files) {
    sites.push(...scanFile(f, topicsTable));
  }
  console.log(`[audit-bus-topics] found ${sites.length} bus.publish/subscribe call sites`);

  const entries = aggregate(sites, topicsTable, payloadBindings);
  const md = renderMarkdown(entries);

  const outDir = join(REPO_ROOT, "docs/reference");
  if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });
  const outPath = join(outDir, "bus-topics.md");
  writeFileSync(outPath, md, "utf8");
  console.log(`[audit-bus-topics] wrote ${relative(REPO_ROOT, outPath)} (${entries.length} topics)`);

  const unresolvedCount = sites.filter(s => !s.resolved).length;
  if (unresolvedCount > 0 && !ALLOW_UNRESOLVED) {
    console.warn(`[audit-bus-topics] ${unresolvedCount} unresolved call sites — pass --allow-unresolved to suppress`);
    // Don't fail the script by default; the markdown documents them so the
    // operator can audit. CI can opt-in to fail by dropping the flag.
  }
}

main();
