#!/usr/bin/env bun
/**
 * gen-api-docs — static AST scan of every HTTP route definition in src/api/*.ts,
 * resolved to (method, path, source-module, description) and dumped as a single
 * "Swagger-for-the-HTTP-surface" markdown reference at docs/reference/http-api.md.
 *
 * Mirrors scripts/audit-bus-topics.ts: same TypeScript-compiler-API scan, same
 * AUTO-GENERATED header convention, same lines.push(...) + writeFileSync emit.
 *
 * What counts as a route:
 *   An object literal that has BOTH a `method` (string literal: GET/POST/PUT/
 *   DELETE/PATCH) AND a `path` (string literal, e.g. "/api/a2a/chat", may carry
 *   ":params") property — e.g.
 *     { method: "POST", path: "/api/a2a/chat", handler: (req) => handleChat(req) }
 *
 * Description resolution (best-effort, accuracy over completeness):
 *   1. A JSDoc/line comment immediately preceding the route object literal.
 *   2. Else, if the route's `handler` cleanly resolves to a single named
 *      function in the same file (e.g. `req => handleCostSummaries(req)` or
 *      `() => handleGetIncidents()`), the JSDoc on that function.
 *   3. Else, no description (left blank — we do not guess).
 *
 * Usage:
 *   bun run scripts/gen-api-docs.ts        (or: bun run docs:api)
 *
 * Output:
 *   docs/reference/http-api.md  (regenerated; safe to commit)
 *
 * Exit code: always 0. Routes whose `path` is not a static string literal are
 * surfaced in an "Unresolved routes" section rather than silently dropped.
 */

import * as ts from "typescript";
import { readdirSync, readFileSync, writeFileSync, existsSync, mkdirSync, statSync } from "node:fs";
import { join, relative, basename } from "node:path";

// ─────────────────────────────────────────────────────────────────────────────
// File discovery

const REPO_ROOT = process.cwd();
const SCAN_ROOT = "src/api";
const EXCLUDE_DIRS = new Set(["node_modules", ".git", "dist", "build", "__tests__"]);
const EXCLUDE_FILES = new Set(["types.ts"]);
const EXCLUDE_SUFFIXES = [".test.ts", ".d.ts"];

function walkTsFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    let st;
    try { st = statSync(full); } catch { continue; }
    if (st.isDirectory()) {
      if (EXCLUDE_DIRS.has(entry)) continue;
      walkTsFiles(full, out);
    } else if (
      st.isFile() &&
      entry.endsWith(".ts") &&
      !EXCLUDE_FILES.has(entry) &&
      !EXCLUDE_SUFFIXES.some(s => entry.endsWith(s))
    ) {
      out.push(full);
    }
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// JSDoc / leading-comment extraction (mirrors audit-bus-topics.ts readJsDoc)

function cleanJsDoc(raw: string): string {
  return raw
    .replace(/^\/\*\*?/, "")
    .replace(/\*\/$/, "")
    .split("\n")
    .map(l => l.replace(/^\s*\*\s?/, "").trim())
    .filter(Boolean)
    .join(" ")
    .trim();
}

function cleanLineComment(raw: string): string {
  return raw
    .split("\n")
    .map(l => l.replace(/^\s*\/\/\s?/, "").trim())
    .filter(Boolean)
    .join(" ")
    .trim();
}

/** One-line description from the leading comment immediately above a node. */
function readLeadingComment(node: ts.Node): string | undefined {
  const sf = node.getSourceFile();
  const ranges = ts.getLeadingCommentRanges(sf.text, node.getFullStart());
  if (!ranges || ranges.length === 0) return undefined;
  // Take the comment closest to the node (last in the list).
  const r = ranges[ranges.length - 1];
  const raw = sf.text.slice(r.pos, r.end);
  let text: string;
  if (r.kind === ts.SyntaxKind.MultiLineCommentTrivia) {
    text = cleanJsDoc(raw);
  } else if (r.kind === ts.SyntaxKind.SingleLineCommentTrivia) {
    text = cleanLineComment(raw);
  } else {
    return undefined;
  }
  return firstSentence(text);
}

/** Collapse a doc blob to a single readable line (first sentence / first line). */
function firstSentence(text: string): string | undefined {
  if (!text) return undefined;
  let out = text.trim();

  // Reject decorative banner comments (runs of box-drawing / dash glyphs with no
  // real prose left once the glyphs are stripped) — but keep the inner label.
  // e.g. "── Gmail: search ──────" → "Gmail: search".
  out = out.replace(/[─—–\-=_*]{2,}/g, " ").replace(/\s{2,}/g, " ").trim();
  if (!out) return undefined;

  // Drop a leading "GET /api/foo — " / "POST /api/foo?x= : " echo of method+path;
  // the table already shows those columns, so the prose is redundant. Path token
  // is taken up to the first whitespace OR a separator (— - :), tolerating query
  // strings (?a=&b=) embedded in the path.
  out = out.replace(/^(GET|POST|PUT|DELETE|PATCH|HEAD|OPTIONS)\b[^.!?\n]*?(—|:)\s*/i, "").trim();
  // Also handle the no-separator form "GET /api/foo Returns …" (path then prose).
  out = out.replace(/^(GET|POST|PUT|DELETE|PATCH|HEAD|OPTIONS)\s+\/\S+\s+/i, "").trim();

  // Now take the first sentence (period/!/ terminated). We avoid splitting on "?"
  // here because query strings legitimately contain it.
  const m = out.match(/^(.*?[.!])(\s|$)/);
  if (m) out = m[1].trim();
  return out || undefined;
}

// ─────────────────────────────────────────────────────────────────────────────
// AST scan for route object literals

const HTTP_METHODS = new Set(["GET", "POST", "PUT", "DELETE", "PATCH", "HEAD", "OPTIONS"]);

interface RouteSite {
  method: string;
  path: string;          // resolved literal, or heuristic placeholder when unresolved
  resolved: boolean;     // false → path not a static string literal
  source: string;        // module filename, e.g. "incidents.ts"
  file: string;          // repo-relative path
  line: number;
  description?: string;
}

/** Pull the string-literal value of a named property from an object literal. */
function stringProp(obj: ts.ObjectLiteralExpression, name: string): string | undefined {
  for (const prop of obj.properties) {
    if (!ts.isPropertyAssignment(prop)) continue;
    if (!ts.isIdentifier(prop.name) && !ts.isStringLiteral(prop.name)) continue;
    const pname = ts.isIdentifier(prop.name) ? prop.name.text : prop.name.text;
    if (pname !== name) continue;
    const init = prop.initializer;
    if (ts.isStringLiteral(init) || ts.isNoSubstitutionTemplateLiteral(init)) return init.text;
    return undefined; // present but not a static string literal
  }
  return undefined;
}

/** True if the object literal has a property with the given name (any value). */
function hasProp(obj: ts.ObjectLiteralExpression, name: string): boolean {
  return obj.properties.some(
    p => ts.isPropertyAssignment(p) && ts.isIdentifier(p.name) && p.name.text === name,
  );
}

/**
 * If the route's `handler` is a thin arrow that delegates to a single named
 * function call (e.g. `(req) => handleChat(req)` or `() => handleGetIncidents()`),
 * return that function name so we can look up its JSDoc.
 */
function handlerTargetName(obj: ts.ObjectLiteralExpression): string | undefined {
  for (const prop of obj.properties) {
    if (!ts.isPropertyAssignment(prop)) continue;
    if (!ts.isIdentifier(prop.name) || prop.name.text !== "handler") continue;
    const init = prop.initializer;
    if (!ts.isArrowFunction(init)) {
      if (ts.isIdentifier(init)) return init.text; // handler: handleX
      return undefined;
    }
    const body = init.body;
    // Arrow with expression body: (req) => handleX(req)
    if (ts.isCallExpression(body) && ts.isIdentifier(body.expression)) {
      return body.expression.text;
    }
    return undefined;
  }
  return undefined;
}

/** Map of named-function declarations in a source file → their JSDoc summary. */
function collectFunctionDocs(sf: ts.SourceFile): Map<string, string> {
  const docs = new Map<string, string>();
  function visit(node: ts.Node): void {
    // function foo() {}
    if (ts.isFunctionDeclaration(node) && node.name) {
      const d = jsDocSummary(node);
      if (d) docs.set(node.name.text, d);
    }
    // const foo = (…) => {}  /  const foo = function () {}
    if (ts.isVariableStatement(node)) {
      for (const decl of node.declarationList.declarations) {
        if (!ts.isIdentifier(decl.name)) continue;
        if (!decl.initializer) continue;
        if (ts.isArrowFunction(decl.initializer) || ts.isFunctionExpression(decl.initializer)) {
          const d = jsDocSummary(node) ?? jsDocSummary(decl);
          if (d) docs.set(decl.name.text, d);
        }
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(sf);
  return docs;
}

/** First JSDoc block on a node, summarized to one line. */
function jsDocSummary(node: ts.Node): string | undefined {
  const sf = node.getSourceFile();
  const ranges = ts.getLeadingCommentRanges(sf.text, node.getFullStart());
  if (!ranges) return undefined;
  for (const r of ranges) {
    if (r.kind !== ts.SyntaxKind.MultiLineCommentTrivia) continue;
    const raw = sf.text.slice(r.pos, r.end);
    if (!raw.startsWith("/**")) continue;
    return firstSentence(cleanJsDoc(raw));
  }
  return undefined;
}

function scanFile(file: string): RouteSite[] {
  const source = readFileSync(file, "utf8");
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  const rel = relative(REPO_ROOT, file);
  const src = basename(file);
  const fnDocs = collectFunctionDocs(sf);
  const sites: RouteSite[] = [];

  function visit(node: ts.Node): void {
    if (ts.isObjectLiteralExpression(node) && hasProp(node, "method") && hasProp(node, "path")) {
      const method = stringProp(node, "method");
      const path = stringProp(node, "path");
      // Only treat as a route when method is a recognized HTTP verb literal.
      if (method && HTTP_METHODS.has(method.toUpperCase())) {
        const start = sf.getLineAndCharacterOfPosition(node.getStart(sf));
        const resolved = typeof path === "string";
        // Description: leading comment on the route literal, else handler's JSDoc.
        let description = readLeadingComment(node);
        if (!description) {
          const target = handlerTargetName(node);
          if (target) description = fnDocs.get(target);
        }
        sites.push({
          method: method.toUpperCase(),
          path: path ?? "{computed}",
          resolved,
          source: src,
          file: rel,
          line: start.line + 1,
          description,
        });
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(sf);
  return sites;
}

// ─────────────────────────────────────────────────────────────────────────────
// Grouping + render

/** Group key = first two path segments for /api/<group>, else first segment. */
function groupKey(path: string): string {
  const segs = path.split("/").filter(Boolean);
  if (segs.length === 0) return "(root)";
  if (segs[0] === "api" && segs.length >= 2) return `/api/${segs[1]}`;
  return `/${segs[0]}`;
}

function escCell(s: string): string {
  return s.replace(/\|/g, "\\|").replace(/\n/g, " ");
}

function renderMarkdown(sites: RouteSite[]): string {
  const generated = new Date().toISOString();
  const resolved = sites.filter(s => s.resolved);
  const unresolved = sites.filter(s => !s.resolved);
  const withDesc = resolved.filter(s => s.description).length;

  // Group resolved routes.
  const byGroup = new Map<string, RouteSite[]>();
  for (const s of resolved) {
    const g = groupKey(s.path);
    const arr = byGroup.get(g) ?? [];
    arr.push(s);
    byGroup.set(g, arr);
  }

  const methodOrder = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"];
  const methodRank = (m: string) => {
    const i = methodOrder.indexOf(m);
    return i === -1 ? methodOrder.length : i;
  };

  const lines: string[] = [];
  lines.push("---");
  lines.push("title: HTTP API");
  lines.push("---");
  lines.push("");
  lines.push("> AUTO-GENERATED by `bun run docs:api`. Do not edit by hand — regenerate after changing route definitions in `src/api/*.ts`.");
  lines.push("");
  lines.push(`Generated ${generated}.`);
  lines.push("");
  lines.push("## Summary");
  lines.push("");
  lines.push(`- **${resolved.length}** HTTP routes across **${byGroup.size}** path groups`);
  lines.push(`- **${withDesc}** routes carry a resolved one-line description`);
  if (unresolved.length > 0) {
    lines.push(`- **${unresolved.length}** route(s) with a non-literal \`path\` (see [Unresolved routes](#unresolved-routes))`);
  }
  lines.push("");
  lines.push("Each row links to the route definition as `path:line` so jumping from this index to the source is a click. Routes are defined as `{ method, path, handler }` literals in `src/api/*.ts` and collected by `src/api/index.ts`.");
  lines.push("");

  const groupNames = [...byGroup.keys()].sort();
  for (const g of groupNames) {
    const rows = (byGroup.get(g) ?? []).slice().sort((a, b) =>
      a.path.localeCompare(b.path) || methodRank(a.method) - methodRank(b.method),
    );
    lines.push(`### \`${g}\``);
    lines.push("");
    lines.push("| Method | Path | Source | Description |");
    lines.push("|---|---|---|---|");
    for (const r of rows) {
      const desc = r.description ? escCell(r.description) : "—";
      lines.push(`| \`${r.method}\` | \`${r.path}\` | \`${r.file}:${r.line}\` | ${desc} |`);
    }
    lines.push("");
  }

  if (unresolved.length > 0) {
    lines.push("## Unresolved routes");
    lines.push("");
    lines.push("These route literals declare a `path` that is not a static string literal (built via a helper or variable at runtime), so the scan can't pin the exact path. They are listed here rather than dropped.");
    lines.push("");
    lines.push("| Method | Source | Description |");
    lines.push("|---|---|---|");
    for (const r of unresolved.slice().sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line)) {
      const desc = r.description ? escCell(r.description) : "—";
      lines.push(`| \`${r.method}\` | \`${r.file}:${r.line}\` | ${desc} |`);
    }
    lines.push("");
  }

  return lines.join("\n") + "\n";
}

// ─────────────────────────────────────────────────────────────────────────────
// Main

function main(): void {
  console.log("[gen-api-docs] scanning…");
  const abs = join(REPO_ROOT, SCAN_ROOT);
  if (!existsSync(abs)) {
    console.error(`[gen-api-docs] ${SCAN_ROOT} not found — run from repo root`);
    process.exit(1);
  }
  const files = walkTsFiles(abs);
  console.log(`[gen-api-docs] scanning ${files.length} .ts files in ${SCAN_ROOT}`);

  const sites: RouteSite[] = [];
  for (const f of files) sites.push(...scanFile(f));
  const resolved = sites.filter(s => s.resolved).length;
  const unresolved = sites.length - resolved;
  console.log(`[gen-api-docs] found ${sites.length} routes (${resolved} resolved, ${unresolved} unresolved)`);

  const md = renderMarkdown(sites);
  const outDir = join(REPO_ROOT, "docs/reference");
  if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });
  const outPath = join(outDir, "http-api.md");
  writeFileSync(outPath, md, "utf8");
  console.log(`[gen-api-docs] wrote ${relative(REPO_ROOT, outPath)}`);
}

main();
