import { describe, test, expect } from "bun:test";
import { chunkFilesIntoBatches } from "../src/llm/reviewOrchestrator.ts";
import type { PRFile } from "../src/llm/types.ts";

function makeFile(filename: string, patchSize: number): PRFile {
  return {
    filename,
    status: "modified",
    additions: 10,
    deletions: 5,
    changes: 15,
    patch: "x".repeat(patchSize),
  };
}

describe("chunkFilesIntoBatches", () => {
  test("returns empty array for empty input", () => {
    const batches = chunkFilesIntoBatches([]);
    expect(batches).toHaveLength(0);
  });

  test("single file fits in one batch", () => {
    const files = [makeFile("src/foo.ts", 1000)];
    const batches = chunkFilesIntoBatches(files);
    expect(batches).toHaveLength(1);
    expect(batches[0].files).toHaveLength(1);
  });

  test("small files are batched together", () => {
    // Each file is ~250 tokens, budget is 80k tokens — all fit in one batch
    const files = [
      makeFile("src/a.ts", 1000),
      makeFile("src/b.ts", 1000),
      makeFile("src/c.ts", 1000),
    ];
    const batches = chunkFilesIntoBatches(files);
    expect(batches).toHaveLength(1);
    expect(batches[0].files).toHaveLength(3);
  });

  test("large files split into multiple batches", () => {
    // 80k tokens budget, 4 chars/token = 320k chars max per batch
    // Create 3 files at ~280k chars each — should split
    const files = [
      makeFile("src/huge1.ts", 280_000 * 4),
      makeFile("src/huge2.ts", 280_000 * 4),
      makeFile("src/huge3.ts", 280_000 * 4),
    ];
    const batches = chunkFilesIntoBatches(files);
    expect(batches.length).toBeGreaterThan(1);
  });

  test("skips files without a patch", () => {
    const files: PRFile[] = [
      {
        filename: "src/nopatch.ts",
        status: "removed",
        additions: 0,
        deletions: 100,
        changes: 100,
        // no patch property
      },
      makeFile("src/withpatch.ts", 500),
    ];
    const batches = chunkFilesIntoBatches(files);
    expect(batches).toHaveLength(1);
    expect(batches[0].files[0].filename).toBe("src/withpatch.ts");
  });

  test("sorts files by size ascending so small files fill batches first", () => {
    const files = [
      makeFile("src/large.ts", 10_000),
      makeFile("src/small.ts", 100),
      makeFile("src/medium.ts", 1_000),
    ];
    const batches = chunkFilesIntoBatches(files);
    // All fit in one batch, but should be sorted small → large
    expect(batches[0].files[0].filename).toBe("src/small.ts");
    expect(batches[0].files[1].filename).toBe("src/medium.ts");
    expect(batches[0].files[2].filename).toBe("src/large.ts");
  });

  test("estimatedTokens is populated", () => {
    const files = [makeFile("src/foo.ts", 400)];
    const batches = chunkFilesIntoBatches(files);
    expect(batches[0].estimatedTokens).toBeGreaterThan(0);
  });
});
