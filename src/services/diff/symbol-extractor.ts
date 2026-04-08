/**
 * Symbol extractor — routes diff lines to language-specific extractors.
 *
 * Supports: TypeScript (.ts, .tsx, .js, .jsx), Python (.py), Go (.go).
 * For unsupported languages, logs a warning and returns an empty array.
 */

import { extractTypeScriptSymbols } from "./symbols/typescript.ts";
import { extractPythonSymbols } from "./symbols/python.ts";
import { extractGoSymbols } from "./symbols/go.ts";
import type { DiffFile } from "./chunker.ts";

// ── Types ──────────────────────────────────────────────────────────────────────

export type SymbolType = "function" | "class" | "interface" | "export" | "method";
export type Language = "typescript" | "python" | "go" | "unknown";

export interface ExtractedSymbol {
  name: string;
  type: SymbolType;
  line: number;
  language: Language;
  filePath?: string;
}

// ── Language detection ─────────────────────────────────────────────────────────

function detectLanguage(filePath: string): Language {
  const ext = filePath.split(".").pop()?.toLowerCase() ?? "";
  if (["ts", "tsx", "js", "jsx", "mts", "cts", "mjs", "cjs"].includes(ext)) return "typescript";
  if (ext === "py") return "python";
  if (ext === "go") return "go";
  return "unknown";
}

// ── Main extractor ─────────────────────────────────────────────────────────────

/**
 * Extract symbols from all added/modified lines in a diff file.
 *
 * Only processes added lines (lines starting with "+") from hunks.
 * Skips unsupported languages with a warning.
 */
export function extractSymbols(file: DiffFile): ExtractedSymbol[] {
  const language = detectLanguage(file.path);

  if (language === "unknown") {
    const ext = file.path.split(".").pop() ?? "unknown";
    console.warn(`[symbol-extractor] Unsupported language extension .${ext} for ${file.path} — skipping pattern extraction`);
    return [];
  }

  const symbols: ExtractedSymbol[] = [];

  for (const hunk of file.hunks) {
    // Only extract from added/modified lines
    const addedLines: string[] = [];
    const lineNumbers: number[] = [];
    let lineNum = hunk.startLine;

    for (const line of hunk.lines) {
      if (line.startsWith("+")) {
        addedLines.push(line.slice(1)); // strip the leading "+"
        lineNumbers.push(lineNum);
        lineNum++;
      } else if (!line.startsWith("-")) {
        // Context line — advance line counter but don't extract
        lineNum++;
      }
      // Removed lines (-) don't advance the new file's line counter
    }

    if (addedLines.length === 0) continue;

    let extracted: ExtractedSymbol[];
    const startLine = lineNumbers[0] ?? hunk.startLine;

    if (language === "typescript") {
      extracted = extractTypeScriptSymbols(addedLines, startLine);
    } else if (language === "python") {
      extracted = extractPythonSymbols(addedLines, startLine);
    } else {
      extracted = extractGoSymbols(addedLines, startLine);
    }

    for (const sym of extracted) {
      symbols.push({ ...sym, filePath: file.path });
    }
  }

  return symbols;
}

/**
 * Extract symbols from multiple diff files.
 */
export function extractAllSymbols(files: DiffFile[]): ExtractedSymbol[] {
  return files.flatMap(f => extractSymbols(f));
}
