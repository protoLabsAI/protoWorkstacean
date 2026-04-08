/**
 * TypeScript/JavaScript symbol extractor.
 *
 * Extracts function definitions, class/interface declarations, and export
 * statements from TypeScript source code lines.
 */

import type { ExtractedSymbol } from "../symbol-extractor.ts";

// Patterns for TypeScript symbol extraction
const PATTERNS: Array<{ regex: RegExp; type: ExtractedSymbol["type"] }> = [
  // function foo(...) / async function foo(...) / export function foo(...)
  { regex: /^(?:export\s+)?(?:async\s+)?function\s+(\w+)\s*[(<]/, type: "function" },
  // const foo = (...) => / export const foo = async (...) =>
  { regex: /^(?:export\s+)?(?:const|let|var)\s+(\w+)\s*=\s*(?:async\s+)?(?:\(|function)/, type: "function" },
  // class Foo / export class Foo / export default class Foo
  { regex: /^(?:export\s+)?(?:default\s+)?class\s+(\w+)[\s{<(]/, type: "class" },
  // interface Foo / export interface Foo
  { regex: /^(?:export\s+)?interface\s+(\w+)[\s{<]/, type: "interface" },
  // type Foo = / export type Foo =
  { regex: /^(?:export\s+)?type\s+(\w+)\s*[=<{]/, type: "interface" },
  // export { foo, bar }
  { regex: /^export\s+\{([^}]+)\}/, type: "export" },
  // export default foo / export default function
  { regex: /^export\s+default\s+(?:function\s+)?(\w+)/, type: "export" },
  // method definitions inside classes: methodName(...) or async methodName(...)
  { regex: /^\s+(?:async\s+)?(\w+)\s*\((?!.*=>)/, type: "function" },
];

/**
 * Extract symbols from TypeScript/JavaScript added/modified lines.
 */
export function extractTypeScriptSymbols(
  lines: string[],
  lineOffset: number = 1,
): ExtractedSymbol[] {
  const symbols: ExtractedSymbol[] = [];
  const seen = new Set<string>();

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trimStart();
    const lineNumber = lineOffset + i;

    for (const { regex, type } of PATTERNS) {
      const match = line.match(regex);
      if (!match) continue;

      if (type === "export" && match[1]) {
        // Handle export { foo, bar } — extract multiple names
        const names = match[1].split(",").map(n => n.trim().split(/\s+as\s+/)[0].trim());
        for (const name of names) {
          if (name && !seen.has(`${name}:${lineNumber}`)) {
            seen.add(`${name}:${lineNumber}`);
            symbols.push({ name, type, line: lineNumber, language: "typescript" });
          }
        }
      } else if (match[1]) {
        const name = match[1];
        if (!seen.has(`${name}:${lineNumber}`)) {
          seen.add(`${name}:${lineNumber}`);
          symbols.push({ name, type, line: lineNumber, language: "typescript" });
        }
      }
      break; // First matching pattern wins per line
    }
  }

  return symbols;
}
