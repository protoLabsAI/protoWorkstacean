/**
 * sanitize.ts — Issue body sanitizer for the auto-triage pipeline.
 *
 * Strips prompt injection patterns and enforces size limits on untrusted
 * (non-org, trust tier < 3) GitHub issue submissions before they reach
 * the agent.
 */

export interface SanitizationConfig {
  maxBodyChars: number;
  maxLineLengthChars: number;
  injectionPatterns: string[];
  spamThreshold: number;
}

export interface SanitizationResult {
  /** Body text after redaction and truncation. */
  body: string;
  /** Raw regex strings from injectionPatterns that matched. */
  patternsFound: string[];
}

/**
 * Sanitize an issue body submitted by an untrusted (tier < 3) author.
 *
 * Steps applied in order:
 *   1. Detect injection patterns — collect all that match
 *   2. Redact matched pattern text from the body
 *   3. Truncate individual lines to maxLineLengthChars
 *   4. Truncate total body to maxBodyChars
 *
 * Callers compare patternsFound.length against spamThreshold to decide
 * whether to route to an agent or close the issue as spam.
 */
export function sanitizeIssueBody(
  body: string,
  config: SanitizationConfig,
): SanitizationResult {
  const patternsFound: string[] = [];

  let sanitized = body;

  for (const pattern of config.injectionPatterns) {
    try {
      const re = new RegExp(pattern, "im");
      if (re.test(sanitized)) {
        patternsFound.push(pattern);
        // Redact all occurrences (global, case-insensitive, multiline)
        const reAll = new RegExp(pattern, "gim");
        sanitized = sanitized.replace(reAll, "[redacted]");
      }
    } catch {
      // Skip malformed regex patterns — never crash the triage pipeline
    }
  }

  // Truncate long lines
  sanitized = sanitized
    .split("\n")
    .map((line) =>
      line.length > config.maxLineLengthChars
        ? line.slice(0, config.maxLineLengthChars)
        : line,
    )
    .join("\n");

  // Truncate total body
  if (sanitized.length > config.maxBodyChars) {
    sanitized = sanitized.slice(0, config.maxBodyChars);
  }

  return { body: sanitized, patternsFound };
}
