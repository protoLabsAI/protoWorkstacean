/**
 * Go symbol extractor.
 *
 * Extracts function/method definitions, type declarations from Go source lines.
 */

import type { ExtractedSymbol } from "../symbol-extractor.ts";

const PATTERNS: Array<{ regex: RegExp; type: ExtractedSymbol["type"] }> = [
  // func FooBar(...) or func (r *Receiver) Method(...)
  { regex: /^func\s+(?:\(\w+\s+[*\w]+\)\s+)?(\w+)\s*\(/, type: "function" },
  // type Foo struct { / type Foo interface {
  { regex: /^type\s+(\w+)\s+(?:struct|interface)\s*\{/, type: "class" },
  // type Foo = Bar (type alias)
  { regex: /^type\s+(\w+)\s*=/, type: "interface" },
  // var FooBar = ... (package-level variable)
  { regex: /^var\s+(\w+)\s+/, type: "export" },
  // const FooBar = ... (exported constant)
  { regex: /^const\s+([A-Z]\w+)\s+/, type: "export" },
];

/**
 * Extract symbols from Go added/modified lines.
 */
export function extractGoSymbols(
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
      if (!match?.[1]) continue;

      const name = match[1];
      if (!seen.has(`${name}:${lineNumber}`)) {
        seen.add(`${name}:${lineNumber}`);
        symbols.push({ name, type, line: lineNumber, language: "go" });
      }
      break;
    }
  }

  return symbols;
}
