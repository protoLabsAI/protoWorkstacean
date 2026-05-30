#!/usr/bin/env bun
/**
 * gen-agent-tools — static AST scan of the LangChain tool registry in
 * src/executor/executors/deep-agent-executor.ts (the `const all` object inside
 * createLangChainTools), resolved to each tool's `name` + `description`, then
 * cross-referenced against `workspace/agents/*.yaml` `tools:` lists to show which
 * agents expose each tool. The result replaces ONLY the generated tool-list
 * section of docs/reference/agent-skills.md (between stable HTML-comment markers)
 * — the surrounding conceptual prose is preserved.
 *
 * Mirrors scripts/gen-api-docs.ts + scripts/audit-bus-topics.ts: same
 * TypeScript-compiler-API scan, same AUTO-GENERATED header convention.
 *
 * What counts as a tool:
 *   A `tool(handler, { name: "...", description: "...", schema: ... })` call.
 *   We extract the string-literal `name` and `description` from the 2nd-arg
 *   object literal. Multi-line `"a " + "b"` concatenated descriptions are
 *   flattened. Tools whose name/description aren't static string literals are
 *   skipped (none today).
 *
 * Agent mapping:
 *   Each `workspace/agents/<name>.yaml` (not *.example) declares a `tools:` list.
 *   We parse those lists and, per tool, list the agents that expose it. Tools
 *   declared in a YAML but absent from the registry are ignored (the runtime
 *   filters them); tools in the registry exposed by no agent show "—".
 *
 * Usage:
 *   bun run scripts/gen-agent-tools.ts        (or: bun run docs:tools)
 *
 * Output:
 *   docs/reference/agent-skills.md  (only the generated-tools section is rewritten)
 *
 * Exit code: always 0.
 */

import * as ts from "typescript";
import { readFileSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";

const REPO_ROOT = process.cwd();
const REGISTRY_FILE = "src/executor/executors/deep-agent-executor.ts";
const AGENTS_DIR = "workspace/agents";
const DOC_FILE = "docs/reference/agent-skills.md";

const BEGIN_MARKER = "<!-- BEGIN:generated-tools -->";
const END_MARKER = "<!-- END:generated-tools -->";

// ─────────────────────────────────────────────────────────────────────────────
// Extract tool name + description from the `tool(...)` registry

interface ToolEntry {
  name: string;
  description: string;
}

/** Flatten a string literal or `"a" + "b" + …` concatenation to one string. */
function flattenString(expr: ts.Expression): string | undefined {
  if (ts.isStringLiteral(expr) || ts.isNoSubstitutionTemplateLiteral(expr)) {
    return expr.text;
  }
  if (ts.isBinaryExpression(expr) && expr.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    const left = flattenString(expr.left);
    const right = flattenString(expr.right);
    if (left === undefined || right === undefined) return undefined;
    return left + right;
  }
  if (ts.isParenthesizedExpression(expr)) return flattenString(expr.expression);
  return undefined;
}

/** Read a string-valued property (literal or concatenation) from an object literal. */
function stringProp(obj: ts.ObjectLiteralExpression, name: string): string | undefined {
  for (const prop of obj.properties) {
    if (!ts.isPropertyAssignment(prop)) continue;
    if (!ts.isIdentifier(prop.name) || prop.name.text !== name) continue;
    return flattenString(prop.initializer);
  }
  return undefined;
}

function scanRegistry(): ToolEntry[] {
  const file = join(REPO_ROOT, REGISTRY_FILE);
  const source = readFileSync(file, "utf8");
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  const tools: ToolEntry[] = [];
  const seen = new Set<string>();

  function visit(node: ts.Node): void {
    // tool(handler, { name, description, schema }) — the metadata is the LAST
    // object-literal argument. Some tools are written inline as bare object
    // literals { name, description, schema } (no surrounding tool() with a
    // handler) — handle both by scanning any object literal with name+description.
    if (ts.isObjectLiteralExpression(node)) {
      const name = stringProp(node, "name");
      const description = stringProp(node, "description");
      // Only treat as a tool-metadata object when it has a `schema` property too,
      // so we don't pick up unrelated { name, description } pairs.
      const hasSchema = node.properties.some(
        p => ts.isPropertyAssignment(p) && ts.isIdentifier(p.name) && p.name.text === "schema",
      );
      if (name && description && hasSchema && !seen.has(name)) {
        seen.add(name);
        tools.push({ name, description: collapse(description) });
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(sf);
  return tools;
}

/** Collapse whitespace runs to single spaces for clean table cells. */
function collapse(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

// ─────────────────────────────────────────────────────────────────────────────
// Parse workspace/agents/*.yaml `tools:` lists (no YAML dep — simple list scan)

/** Map of toolName → sorted list of agent names exposing it. */
function buildAgentMap(): Map<string, string[]> {
  const dir = join(REPO_ROOT, AGENTS_DIR);
  const map = new Map<string, string[]>();
  if (!existsSync(dir)) return map;

  for (const entry of readdirSync(dir).sort()) {
    if (!entry.endsWith(".yaml")) continue; // skip *.example
    const text = readFileSync(join(dir, entry), "utf8");
    const agentName = parseAgentName(text) ?? entry.replace(/\.yaml$/, "");
    for (const tool of parseToolsList(text)) {
      const arr = map.get(tool) ?? [];
      if (!arr.includes(agentName)) arr.push(agentName);
      map.set(tool, arr);
    }
  }
  for (const arr of map.values()) arr.sort();
  return map;
}

function parseAgentName(text: string): string | undefined {
  const m = text.match(/^name:\s*(.+)$/m);
  return m ? m[1].trim().replace(/^["']|["']$/g, "") : undefined;
}

/**
 * Extract the entries of the top-level `tools:` list. Handles both the
 * inline form (`tools: []` / `tools: [a, b]`) and the block form:
 *
 *   tools:
 *     - foo   # comment
 *     - bar
 *   maxTurns: 25
 */
function parseToolsList(text: string): string[] {
  const lines = text.split("\n");
  const out: string[] = [];
  let inBlock = false;
  for (const line of lines) {
    if (!inBlock) {
      const m = line.match(/^tools:\s*(.*)$/);
      if (!m) continue;
      const rest = m[1].trim();
      const inline = rest.match(/^\[(.*)\]$/);
      if (inline) {
        for (const tok of inline[1].split(",")) {
          const t = tok.trim();
          if (t) out.push(t.replace(/^["']|["']$/g, ""));
        }
        return out;
      }
      inBlock = true; // block form follows
      continue;
    }
    // In the block: list items are `  - name`; stop at the next top-level key.
    const item = line.match(/^\s+-\s*([A-Za-z0-9_.]+)/);
    if (item) {
      out.push(item[1]);
      continue;
    }
    if (/^\s*#/.test(line) || line.trim() === "") continue; // comment / blank
    if (/^\S/.test(line)) break; // next top-level key → tools block ended
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// Render the generated tool-list block

function renderBlock(tools: ToolEntry[], agentMap: Map<string, string[]>): string {
  const sorted = tools.slice().sort((a, b) => a.name.localeCompare(b.name));
  const lines: string[] = [];
  lines.push(BEGIN_MARKER);
  lines.push("");
  lines.push(
    "> AUTO-GENERATED by `bun run docs:tools`. Do not edit the table by hand — " +
      "regenerate after changing the tool registry in `src/executor/executors/deep-agent-executor.ts` " +
      "or any `workspace/agents/*.yaml` `tools:` list.",
  );
  lines.push("");
  lines.push(
    `**${sorted.length}** tools are defined in the DeepAgent tool registry. Each agent's ` +
      "`tools:` list in `workspace/agents/<name>.yaml` selects which of these it exposes; a skill " +
      "may further narrow the set via its own `tools:`.",
  );
  lines.push("");
  lines.push("| Tool | Description | Agents |");
  lines.push("|---|---|---|");
  for (const t of sorted) {
    const agents = agentMap.get(t.name) ?? [];
    const agentCell = agents.length ? agents.map(a => `\`${a}\``).join(", ") : "—";
    lines.push(`| \`${t.name}\` | ${escCell(t.description)} | ${agentCell} |`);
  }
  lines.push("");
  lines.push(END_MARKER);
  return lines.join("\n");
}

function escCell(s: string): string {
  return s.replace(/\|/g, "\\|").replace(/\n/g, " ");
}

// ─────────────────────────────────────────────────────────────────────────────
// Splice the block into the doc between markers (insert if absent)

function spliceDoc(doc: string, block: string): string {
  const begin = doc.indexOf(BEGIN_MARKER);
  const end = doc.indexOf(END_MARKER);
  if (begin !== -1 && end !== -1 && end > begin) {
    const before = doc.slice(0, begin);
    const after = doc.slice(end + END_MARKER.length);
    return before + block + after;
  }
  // First run: markers absent. Replace the hand-maintained tool list. It begins
  // at the prose line that points to deep-agent-executor.ts and runs through the
  // bullet lines that follow, up to the next "### " heading.
  const lines = doc.split("\n");
  const anchorIdx = lines.findIndex(l => /canonical.*list.*deep-agent-executor\.ts/i.test(l));
  if (anchorIdx !== -1) {
    let endIdx = anchorIdx + 1;
    while (endIdx < lines.length && !/^### /.test(lines[endIdx])) endIdx++;
    const before = lines.slice(0, anchorIdx).join("\n").replace(/\n+$/, "") + "\n\n";
    const after = "\n\n" + lines.slice(endIdx).join("\n").replace(/^\n+/, "");
    return before + block + after;
  }
  // No anchor either — append before the first "## " after the intro, else at end.
  return doc.replace(/\n+$/, "") + "\n\n" + block + "\n";
}

// ─────────────────────────────────────────────────────────────────────────────

function main(): void {
  console.log("[gen-agent-tools] scanning tool registry…");
  const tools = scanRegistry();
  const agentMap = buildAgentMap();
  console.log(
    `[gen-agent-tools] found ${tools.length} tools; ${agentMap.size} tools mapped to agents`,
  );

  const docPath = join(REPO_ROOT, DOC_FILE);
  if (!existsSync(docPath)) {
    console.error(`[gen-agent-tools] ${DOC_FILE} not found — run from repo root`);
    process.exit(1);
  }
  const doc = readFileSync(docPath, "utf8");
  const block = renderBlock(tools, agentMap);
  const next = spliceDoc(doc, block);
  writeFileSync(docPath, next, "utf8");
  console.log(`[gen-agent-tools] wrote ${relative(REPO_ROOT, docPath)}`);
}

main();
