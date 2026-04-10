/**
 * Context formatter — assembles retrieved Qdrant context into a structured
 * CODEBASE CONTEXT block for injection into Quinn's review prompt.
 *
 * Block format:
 *   CODEBASE CONTEXT:
 *   Past PR decisions on <file>:
 *     - PR #<n> (<date>): APPROVE/REQUEST_CHANGES — <issues>
 *   Similar code patterns:
 *     - `<symbol>` used in <file>:<line> (<repo>)
 *       <context snippet>
 */

import type { PastPRDecision } from "../qdrant/past-pr-retriever.ts";
import type { SimilarPattern } from "../qdrant/pattern-searcher.ts";

export interface CodebaseContext {
  pastDecisions: Map<string, PastPRDecision[]>;   // filePath → decisions
  similarPatterns: Map<string, SimilarPattern[]>; // symbolKey → patterns
}

/**
 * Format a CODEBASE CONTEXT block from retrieved context.
 *
 * Returns an empty string if no context is available.
 */
export function formatCodebaseContext(ctx: CodebaseContext): string {
  const sections: string[] = [];

  // ── Past PR decisions ──────────────────────────────────────────────────────
  if (ctx.pastDecisions.size > 0) {
    const lines: string[] = ["Past PR decisions on changed files:"];

    for (const [filePath, decisions] of ctx.pastDecisions) {
      lines.push(`  ${filePath}:`);
      for (const d of decisions) {
        const date = formatDate(d.mergedAt);
        const issues = d.reviewIssues ? ` — ${d.reviewIssues}` : "";
        lines.push(`    - PR #${d.prNumber} (${date}): ${d.decision}${issues}`);
      }
    }

    sections.push(lines.join("\n"));
  }

  // ── Similar code patterns ──────────────────────────────────────────────────
  if (ctx.similarPatterns.size > 0) {
    const lines: string[] = ["Similar code patterns across the repository:"];

    for (const [symbolKey, patterns] of ctx.similarPatterns) {
      const symbolName = symbolKey.split(":")[0];
      for (const p of patterns) {
        lines.push(`  \`${symbolName}\` in ${p.file}:${p.line} (${p.repo})`);
        // Include a short context snippet (first 3 lines)
        const snippet = p.context.split("\n").slice(0, 3).join("\n    ");
        if (snippet.trim()) {
          lines.push(`    ${snippet}`);
        }
      }
    }

    sections.push(lines.join("\n"));
  }

  if (sections.length === 0) return "";

  return ["CODEBASE CONTEXT:", ...sections].join("\n\n") + "\n";
}

function formatDate(isoString: string): string {
  if (!isoString) return "unknown date";
  try {
    return new Date(isoString).toISOString().slice(0, 10);
  } catch {
    return isoString.slice(0, 10);
  }
}
