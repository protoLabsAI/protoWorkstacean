#!/usr/bin/env bun
/**
 * gen-env-vars — static AST scan of the zod `EnvSchema` in src/config/env.ts,
 * resolved to each env var's name, whether it's optional, and its description
 * (a `.describe("...")` call, else the leading `//` / `/** … *​/` comment), then
 * dumped as docs/reference/env-vars.md.
 *
 * A second, best-effort pass greps src/ + lib/ for `process.env.X` /
 * `process.env["X"]` reads and flags any var read at runtime but NOT declared in
 * EnvSchema — surfaced in a separate "Read directly (not in EnvSchema)" section so
 * the doc is honest about the contract gap (the schema is `.strict()`, so these
 * are reads the schema doesn't model).
 *
 * Mirrors scripts/gen-api-docs.ts + scripts/audit-bus-topics.ts: same
 * TypeScript-compiler-API scan, same AUTO-GENERATED header convention.
 *
 * Usage:
 *   bun run scripts/gen-env-vars.ts        (or: bun run docs:env)
 *
 * Output:
 *   docs/reference/env-vars.md  (regenerated; safe to commit)
 *
 * Exit code: always 0.
 */

import * as ts from "typescript";
import { readdirSync, readFileSync, writeFileSync, existsSync, mkdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const REPO_ROOT = process.cwd();
const SCHEMA_FILE = "src/config/env.ts";
const SCAN_ROOTS = ["src", "lib"];
const EXCLUDE_DIRS = new Set(["node_modules", ".git", "dist", "build", "__tests__"]);
const EXCLUDE_SUFFIXES = [".test.ts", ".d.ts"];
const DOC_FILE = "docs/reference/env-vars.md";

// ─────────────────────────────────────────────────────────────────────────────
// Schema scan

interface EnvVar {
  name: string;
  optional: boolean;
  description?: string;
}

/** Collapse a doc blob (line or block comment) to a single readable line. */
function cleanComment(raw: string): string | undefined {
  let text: string;
  if (raw.startsWith("/*")) {
    text = raw
      .replace(/^\/\*\*?/, "")
      .replace(/\*\/$/, "")
      .split("\n")
      .map(l => l.replace(/^\s*\*\s?/, "").trim())
      .filter(Boolean)
      .join(" ");
  } else {
    text = raw
      .split("\n")
      .map(l => l.replace(/^\s*\/\/\s?/, "").trim())
      .filter(Boolean)
      .join(" ");
  }
  text = text.replace(/\s+/g, " ").trim();
  return text || undefined;
}

/**
 * Description comment immediately above a node. Only `/** … *​/` JSDoc blocks
 * count — `//` line comments in env.ts are section banners ("Core runtime",
 * "LLM gateway", …), not per-var descriptions, so they're ignored.
 */
function leadingComment(node: ts.Node): string | undefined {
  const sf = node.getSourceFile();
  const ranges = ts.getLeadingCommentRanges(sf.text, node.getFullStart());
  if (!ranges || ranges.length === 0) return undefined;
  const r = ranges[ranges.length - 1];
  if (r.kind !== ts.SyntaxKind.MultiLineCommentTrivia) return undefined;
  const raw = sf.text.slice(r.pos, r.end);
  if (!raw.startsWith("/**")) return undefined;
  return cleanComment(raw);
}

/**
 * Walk a zod chain (`z.string().optional().describe("…")`) collecting whether
 * `.optional()` appears and the `.describe(...)` literal if present.
 */
function inspectZodChain(expr: ts.Expression): { optional: boolean; describe?: string } {
  let optional = false;
  let describe: string | undefined;
  let cur: ts.Expression | undefined = expr;
  while (cur && ts.isCallExpression(cur)) {
    const callee = cur.expression;
    if (ts.isPropertyAccessExpression(callee)) {
      const method = callee.name.text;
      if (method === "optional") optional = true;
      if (method === "describe" && cur.arguments.length > 0) {
        const a = cur.arguments[0];
        if (ts.isStringLiteral(a) || ts.isNoSubstitutionTemplateLiteral(a)) describe = a.text;
      }
      cur = callee.expression;
    } else {
      break;
    }
  }
  return { optional, describe };
}

function scanSchema(): EnvVar[] {
  const file = join(REPO_ROOT, SCHEMA_FILE);
  const source = readFileSync(file, "utf8");
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  const vars: EnvVar[] = [];

  // Find the z.object({ ... }) literal that is the EnvSchema base.
  let objLiteral: ts.ObjectLiteralExpression | undefined;
  function findObject(node: ts.Node): void {
    if (objLiteral) return;
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === "object" &&
      node.arguments.length > 0 &&
      ts.isObjectLiteralExpression(node.arguments[0])
    ) {
      objLiteral = node.arguments[0];
      return;
    }
    ts.forEachChild(node, findObject);
  }
  findObject(sf);
  if (!objLiteral) return vars;

  for (const prop of objLiteral.properties) {
    if (!ts.isPropertyAssignment(prop)) continue;
    const key = prop.name;
    const name = ts.isIdentifier(key) ? key.text : ts.isStringLiteral(key) ? key.text : undefined;
    if (!name) continue;
    const { optional, describe } = inspectZodChain(prop.initializer);
    const description = describe ?? leadingComment(prop);
    vars.push({ name, optional, description });
  }
  return vars;
}

// ─────────────────────────────────────────────────────────────────────────────
// process.env grep — vars read at runtime but absent from the schema

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

const ENV_READ_RE = /process\.env\.([A-Z][A-Z0-9_]*)|process\.env\[\s*["']([A-Z][A-Z0-9_]*)["']\s*\]/g;

function scanProcessEnvReads(schemaNames: Set<string>): Map<string, string[]> {
  // var → sorted list of repo-relative files that read it.
  const found = new Map<string, Set<string>>();
  const files: string[] = [];
  for (const root of SCAN_ROOTS) {
    const abs = join(REPO_ROOT, root);
    if (existsSync(abs)) walkTsFiles(abs, files);
  }
  for (const file of files) {
    // env.ts itself defines the contract via the Proxy (process.env[key]) — skip it.
    if (relative(REPO_ROOT, file) === SCHEMA_FILE) continue;
    const text = readFileSync(file, "utf8");
    let m: RegExpExecArray | null;
    ENV_READ_RE.lastIndex = 0;
    while ((m = ENV_READ_RE.exec(text)) !== null) {
      const name = m[1] ?? m[2];
      if (!name || schemaNames.has(name)) continue;
      const set = found.get(name) ?? new Set<string>();
      set.add(relative(REPO_ROOT, file));
      found.set(name, set);
    }
  }
  const out = new Map<string, string[]>();
  for (const [name, set] of found) out.set(name, [...set].sort());
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// Group schema vars by a stable prefix for readability.

function groupOf(name: string): string {
  if (/^WORKSTACEAN_|^WORKSPACE_|^DATA_DIR$|^PORT$|^TZ$|^DEBUG$|^ENABLED_PLUGINS$|^DISABLE_EVENT_VIEWER$/.test(name)) return "Core / runtime";
  if (/^DISCORD_|^DM_|^MAILBOX_/.test(name)) return "Discord";
  if (/^GITHUB_|^QUINN_APP_/.test(name)) return "GitHub";
  if (/^LINEAR_/.test(name)) return "Linear";
  if (/^GOOGLE_/.test(name)) return "Google Workspace";
  if (/^LLM_GATEWAY_|^OPENAI_|^ANTHROPIC_/.test(name)) return "LLM gateway";
  if (/^LANGFUSE_/.test(name)) return "Observability (Langfuse)";
  if (/^QDRANT_|^OLLAMA_|^REDIS_/.test(name)) return "Vector memory";
  if (/^ROUTER_|^DISABLE_ROUTER$/.test(name)) return "Router";
  if (/^AVA_/.test(name)) return "A2A / protoMaker";
  if (/^SIGNAL_/.test(name)) return "Signal";
  return "Other";
}

const GROUP_ORDER = [
  "Core / runtime",
  "LLM gateway",
  "Router",
  "Observability (Langfuse)",
  "A2A / protoMaker",
  "Discord",
  "GitHub",
  "Linear",
  "Google Workspace",
  "Vector memory",
  "Signal",
  "Other",
];

function escCell(s: string): string {
  return s.replace(/\|/g, "\\|").replace(/\n/g, " ");
}

// ─────────────────────────────────────────────────────────────────────────────
// Render

function renderMarkdown(vars: EnvVar[], undeclared: Map<string, string[]>): string {
  const required = vars.filter(v => !v.optional).length;

  const byGroup = new Map<string, EnvVar[]>();
  for (const v of vars) {
    const g = groupOf(v.name);
    const arr = byGroup.get(g) ?? [];
    arr.push(v);
    byGroup.set(g, arr);
  }

  const lines: string[] = [];
  lines.push("---");
  lines.push("title: Environment Variables");
  lines.push("---");
  lines.push("");
  lines.push(
    "> AUTO-GENERATED by `bun run docs:env`. Do not edit by hand — regenerate after changing " +
      "the `EnvSchema` in `src/config/env.ts`.",
  );
  lines.push("");
  lines.push(
    "Every variable recognised by protoWorkstacean is declared in the zod `EnvSchema` in " +
      "`src/config/env.ts`. The schema is `.strict()`: at boot, `parseEnv()` rejects unknown " +
      "schema-shaped keys. All declared vars are optional strings — the system degrades gracefully " +
      "when an integration is unconfigured.",
  );
  lines.push("");
  lines.push("## Summary");
  lines.push("");
  lines.push(`- **${vars.length}** variables declared in \`EnvSchema\``);
  lines.push(`- **${required}** required (no \`.optional()\`); the rest are optional`);
  if (undeclared.size > 0) {
    lines.push(
      `- **${undeclared.size}** variable(s) read via \`process.env\` at runtime but **not** in ` +
        "`EnvSchema` (see [Read directly (not in EnvSchema)](#read-directly-not-in-envschema))",
    );
  }
  lines.push("");

  const groupNames = [
    ...GROUP_ORDER.filter(g => byGroup.has(g)),
    ...[...byGroup.keys()].filter(g => !GROUP_ORDER.includes(g)).sort(),
  ];
  for (const g of groupNames) {
    const rows = (byGroup.get(g) ?? []).slice().sort((a, b) => a.name.localeCompare(b.name));
    lines.push(`## ${g}`);
    lines.push("");
    lines.push("| Variable | Required? | Description |");
    lines.push("|---|---|---|");
    for (const v of rows) {
      const req = v.optional ? "optional" : "**required**";
      const desc = v.description ? escCell(v.description) : "—";
      lines.push(`| \`${v.name}\` | ${req} | ${desc} |`);
    }
    lines.push("");
  }

  if (undeclared.size > 0) {
    lines.push("## Read directly (not in EnvSchema)");
    lines.push("");
    lines.push(
      "These variables are read via `process.env` somewhere in `src/` or `lib/` but are **not** " +
        "declared in `EnvSchema`. Because the schema is `.strict()`, they bypass boot-time " +
        "validation — they work, but they're outside the typed contract. Either add them to " +
        "`EnvSchema` or treat this list as the known contract gap.",
    );
    lines.push("");
    lines.push("| Variable | Read at |");
    lines.push("|---|---|");
    for (const name of [...undeclared.keys()].sort()) {
      const sites = (undeclared.get(name) ?? []).map(f => `\`${f}\``).join(", ");
      lines.push(`| \`${name}\` | ${sites} |`);
    }
    lines.push("");
  }

  return lines.join("\n") + "\n";
}

// ─────────────────────────────────────────────────────────────────────────────

function main(): void {
  console.log("[gen-env-vars] scanning EnvSchema…");
  const vars = scanSchema();
  const schemaNames = new Set(vars.map(v => v.name));
  const undeclared = scanProcessEnvReads(schemaNames);
  console.log(
    `[gen-env-vars] found ${vars.length} schema vars; ${undeclared.size} read-but-undeclared vars`,
  );

  const md = renderMarkdown(vars, undeclared);
  const outDir = join(REPO_ROOT, "docs/reference");
  if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });
  const outPath = join(outDir, "env-vars.md");
  writeFileSync(outPath, md, "utf8");
  console.log(`[gen-env-vars] wrote ${relative(REPO_ROOT, outPath)}`);
}

main();
