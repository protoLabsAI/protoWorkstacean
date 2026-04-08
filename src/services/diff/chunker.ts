/**
 * Diff chunker — parses unified diff format and splits large files into
 * semantic chunks for embedding.
 *
 * Files <= 1000 lines: single chunk per file.
 * Files > 1000 lines: split into 500-line blocks with 50-line overlap.
 */

// ── Types ──────────────────────────────────────────────────────────────────────

export interface DiffHunk {
  header: string;
  lines: string[];
  startLine: number;
  endLine: number;
}

export interface DiffFile {
  path: string;
  hunks: DiffHunk[];
  added: string[];   // only added/modified lines (no context lines)
  removed: string[]; // only removed lines
}

export interface DiffChunk {
  filePath: string;
  content: string;
  lineStart: number;
  lineEnd: number;
  chunkIndex: number;
}

// ── Diff parser ────────────────────────────────────────────────────────────────

/**
 * Parse a unified diff string into per-file structures.
 */
export function parseDiff(diffText: string): DiffFile[] {
  const files: DiffFile[] = [];
  const fileBlocks = diffText.split(/^diff --git /m).filter(Boolean);

  for (const block of fileBlocks) {
    const lines = block.split("\n");

    // Extract file path from "a/foo.ts b/foo.ts" header
    const pathMatch = lines[0]?.match(/^a\/(.+?) b\//);
    if (!pathMatch) continue;
    const path = pathMatch[1];

    const hunks: DiffHunk[] = [];
    const added: string[] = [];
    const removed: string[] = [];

    let currentHunk: DiffHunk | null = null;
    let currentLine = 0;

    for (const line of lines.slice(1)) {
      const hunkHeader = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
      if (hunkHeader) {
        if (currentHunk) hunks.push(currentHunk);
        currentLine = parseInt(hunkHeader[1], 10);
        currentHunk = {
          header: line,
          lines: [],
          startLine: currentLine,
          endLine: currentLine,
        };
        continue;
      }

      if (!currentHunk) continue;

      currentHunk.lines.push(line);

      if (line.startsWith("+")) {
        added.push(line.slice(1));
        currentLine++;
        currentHunk.endLine = currentLine;
      } else if (line.startsWith("-")) {
        removed.push(line.slice(1));
      } else {
        // Context line
        currentLine++;
        currentHunk.endLine = currentLine;
      }
    }

    if (currentHunk) hunks.push(currentHunk);

    files.push({ path, hunks, added, removed });
  }

  return files;
}

// ── Chunker ────────────────────────────────────────────────────────────────────

const CHUNK_SIZE = 500;
const CHUNK_OVERLAP = 50;
const LARGE_FILE_THRESHOLD = 1000;

/**
 * Convert parsed diff files into flat chunks ready for embedding.
 *
 * Each chunk contains the raw diff lines from one or more hunks, plus
 * metadata about the file path and line range.
 */
export function chunkDiff(files: DiffFile[]): DiffChunk[] {
  const chunks: DiffChunk[] = [];

  for (const file of files) {
    // Flatten all hunk lines into a single array with line tracking
    const allLines: { text: string; line: number }[] = [];
    for (const hunk of file.hunks) {
      let lineNum = hunk.startLine;
      for (const line of hunk.lines) {
        allLines.push({ text: line, line: lineNum });
        if (!line.startsWith("-")) lineNum++;
      }
    }

    if (allLines.length === 0) continue;

    if (allLines.length <= LARGE_FILE_THRESHOLD) {
      // Single chunk for small/medium files
      chunks.push({
        filePath: file.path,
        content: allLines.map(l => l.text).join("\n"),
        lineStart: allLines[0].line,
        lineEnd: allLines[allLines.length - 1].line,
        chunkIndex: 0,
      });
    } else {
      // Split large files into overlapping blocks
      let chunkIndex = 0;
      let i = 0;
      while (i < allLines.length) {
        const block = allLines.slice(i, i + CHUNK_SIZE);
        chunks.push({
          filePath: file.path,
          content: block.map(l => l.text).join("\n"),
          lineStart: block[0].line,
          lineEnd: block[block.length - 1].line,
          chunkIndex: chunkIndex++,
        });
        i += CHUNK_SIZE - CHUNK_OVERLAP;
      }
    }
  }

  return chunks;
}
