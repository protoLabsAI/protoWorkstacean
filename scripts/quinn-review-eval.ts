#!/usr/bin/env bun
/**
 * quinn-review-eval — print the PR-review measurement baseline from events.db.
 *
 *   bun scripts/quinn-review-eval.ts [path-to-events.db]
 *
 * Defaults to $WORKSTACEAN_DATA_DIR/events.db, else ./data/events.db. Read-only.
 * Pure aggregation lives in src/knowledge/quinn-review-eval.ts (unit-tested);
 * this is just the reader + pretty-printer.
 */
import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { computeQuinnReviewStats, type EvalEvent } from "../src/knowledge/quinn-review-eval.ts";

const dbPath =
  process.argv[2] ||
  join(process.env.WORKSTACEAN_DATA_DIR || "./data", "events.db");

if (!existsSync(dbPath)) {
  console.error(`events.db not found at ${dbPath} — pass a path or set WORKSTACEAN_DATA_DIR.`);
  process.exit(1);
}

const db = new Database(dbPath, { readonly: true });

const rows = db
  .query(
    `SELECT topic, payload, correlation_id, timestamp FROM events
     WHERE topic LIKE 'autonomous.outcome.%pr_review'
        OR topic = 'agent.runtime.activity.tool.call'
        OR topic = 'quinn.review.submitted'`,
  )
  .all() as { topic: string; payload: string; correlation_id: string; timestamp: number }[];

const events: EvalEvent[] = [];
for (const r of rows) {
  let env: { payload?: Record<string, unknown> };
  try {
    env = JSON.parse(r.payload);
  } catch {
    continue;
  }
  events.push({
    topic: r.topic,
    ts: r.timestamp,
    correlationId: r.correlation_id,
    body: env.payload ?? {},
  });
}

const s = computeQuinnReviewStats(events);
const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
const days = s.window.days.toFixed(1);

console.log(`\nQuinn PR-review eval — ${dbPath}`);
console.log(`window: ${days} days  (${rows.length} events scanned)\n`);

console.log("OUTCOMES");
console.log(`  runs:        ${s.outcomes.total}`);
console.log(`  completed:   ${s.outcomes.completed} (${pct(s.outcomes.completionRate)})`);
console.log(`  failed:      ${s.outcomes.failed}`);
for (const [mode, n] of Object.entries(s.outcomes.failureModes).sort((a, b) => b[1] - a[1])) {
  console.log(`     ${mode.padEnd(16)} ${n}`);
}

if (s.latencyMs) {
  console.log("\nLATENCY (ms, success)");
  console.log(`  min ${s.latencyMs.min}  median ${s.latencyMs.median}  p90 ${s.latencyMs.p90}  max ${s.latencyMs.max}  avg ${s.latencyMs.avg}`);
}

console.log("\nVERDICTS (formal reviews)");
const v = s.verdicts;
const vt = v.total || 1;
console.log(`  APPROVE          ${v.APPROVE} (${pct(v.APPROVE / vt)})`);
console.log(`  COMMENT          ${v.COMMENT} (${pct(v.COMMENT / vt)})`);
console.log(`  REQUEST_CHANGES  ${v.REQUEST_CHANGES} (${pct(v.REQUEST_CHANGES / vt)})`);

console.log("\nTOOL USE");
console.log(`  reviews profiled:  ${s.toolUse.reviewsProfiled}`);
console.log(`  clawpatch used in: ${s.toolUse.clawpatchReviews} (${pct(s.toolUse.clawpatchRate)})`);
if (s.toolUse.callsPerReview) {
  console.log(`  tool-calls/review: median ${s.toolUse.callsPerReview.median}  p90 ${s.toolUse.callsPerReview.p90}  max ${s.toolUse.callsPerReview.max}`);
}
for (const [t, n] of Object.entries(s.toolUse.toolFrequency).sort((a, b) => b[1] - a[1]).slice(0, 8)) {
  console.log(`     ${t.padEnd(20)} ${n}`);
}

if (s.perRepo.length) {
  console.log("\nPER-REPO (top 10)");
  for (const r of s.perRepo.slice(0, 10)) {
    const fail = r.failures ? `  FAIL ${r.failures}` : "";
    console.log(`  ${r.repo.padEnd(32)} ${r.reviews} reviews  (A${r.approve}/C${r.comment}/RC${r.requestChanges})${fail}`);
  }
}
console.log("");

db.close();
