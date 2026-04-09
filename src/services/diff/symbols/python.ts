/**
 * Python symbol extractor.
 *
 * Extracts function definitions, class declarations from Python source lines.
 */

import type { ExtractedSymbol } from "../symbol-extractor.ts";

const PATTERNS: Array<{ regex: RegExp; type: ExtractedSymbol["type"] }> = [
  // def foo( / async def foo(
  { regex: /^(?:async\s+)?def\s+(\w+)\s*\(/, type: "function" },
  // class Foo( / class Foo:
  { regex: /^class\s+(\w+)\s*[:(]/, type: "class" },
  // __all__ = [...] — export equivalent
  { regex: /^__all__\s*=/, type: "export" },
];

/**
 * Extract symbols from Python added/modified lines.
 */
export function extractPythonSymbols(
  lines: string[],
  lineOffset: number = 1,
): ExtractedSymbol[] {
  const symbols: ExtractedSymbol[] = [];
  const seen = new Set<string>();

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineNumber = lineOffset + i;

    for (const { regex, type } of PATTERNS) {
      const match = line.match(regex);
      if (!match) continue;

      const name = match[1] ?? "__all__";
      if (!seen.has(`${name}:${lineNumber}`)) {
        seen.add(`${name}:${lineNumber}`);
        symbols.push({ name, type, line: lineNumber, language: "python" });
      }
      break;
    }
  }

  return symbols;
}
