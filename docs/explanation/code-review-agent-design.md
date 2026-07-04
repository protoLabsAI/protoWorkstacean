---
title: Designing the Code-Review Agent (Quinn)
---

# Designing the code-review agent (Quinn)

This is a due-diligence benchmark of our in-process PR-review agent, **Quinn**,
against the state of the art (2025–2026), plus a prioritized roadmap. It pairs
external research with live observability pulled from `events.db`.

Quinn is a LangGraph ReAct DeepAgent. On every PR she runs `pr_inspector`
(CI status + CodeRabbit threads + diff summary), optionally runs `clawpatch_review`
(our AST/structural review fork), produces a `VERDICT`, and submits a formal GitHub
review (`APPROVE` / `COMMENT` / `REQUEST_CHANGES`) that feeds the auto-merge-on-green
loop.

## Live baseline (events.db, ~7 days)

| Metric | Value |
| --- | --- |
| pr_review runs | 1,523 (~217/day) |
| Completed | 1,498 (98.4%) |
| Failed | 25 (1.6%) — **24 of 25 are "Recursion limit of 37 reached"**, 1 timeout |
| Verdict mix | COMMENT 51% · APPROVE 43% · REQUEST_CHANGES 2.6% |
| Tool-calls / review | median 3, p90 4, max 15 |
| Tool frequency | `pr_inspector` 4,590 · `react` 94 · **`clawpatch_review` 83** · `send_update` 48 |
| clawpatch usage | **~5% of reviews** |
| Latency | avg ~44s, max ~7 min (the thrash tail) |

Two facts stand out: Quinn is effectively a **diff-only reviewer 95% of the time**
(clawpatch, her structural pass, rarely fires), and her only meaningful failure mode
is the **recursion-limit thrash that produces no verdict** and stalls the PR.

## What the field does

### Architecture — diff-only vs whole-repo context

The biggest quality lever. [Greptile](https://www.greptile.com/agent) indexes the
whole repo into a graph (parses the AST, recursively generates per-node docstrings,
embeds them) and runs a swarm of agents doing **multi-hop investigation** — tracing
dependencies, checking git history, following references across files (v3 built on the
Claude Agent SDK). [Benchmarks](https://www.greptile.com/benchmarks) put graph-context
Greptile at **82% catch rate vs CodeRabbit's 44%** (diff-only). Systemic, cross-file
bugs are exactly where diff-only reviewers fail.

**Quinn's `clawpatch` is the structural analog — but at 5% usage it is not the
engine.** The tools that win run structural analysis as the *default* pass.

### Multi-agent specialization

[Cloudflare's production system](https://blog.cloudflare.com/ai-code-review/)
(48,095 MRs / 30 days) runs **seven scoped reviewers** (security, performance, code
quality, docs, release, compliance) + a coordinator, *"rather than relying on one model
with a massive, generic prompt."* Quinn is one ReAct agent wearing all hats. Whether to
follow suit is settled below — see [Specialization decision (#892)](#specialization-decision-892-dont-fan-out-yet).

### Noise reduction — the #1 complaint

Cloudflare's clearest lesson: *"telling an LLM what NOT to do is where the actual prompt
engineering value resides."* Without explicit don't-flag lists they got *"a firehose of
speculative theoretical warnings developers learn to ignore."* Their coordinator runs a
**reasonableness filter** dropping *"speculative issues, nitpicks, false positives, and
convention-contradicted findings,"* and **reads source to verify** when uncertain.
Best-in-class tools hold [5–15% false-positive rates](https://www.propelcode.ai/blog/ai-code-review-false-positives-reducing-noise)
with per-type tolerances ([security <3%, style <2%](https://www.codeant.ai/blogs/ai-code-review-false-positives)).

**Quinn is ahead of the field on grounding** — her Step 2c rule (*every HIGH/CRITICAL on
an external reference must rest on a fetched EXISTS/MISSING fact, else it's a Gap*) is the
"read source to verify" discipline, formalized. She lacks an explicit **"what NOT to
flag"** list (see the prompt-policy decision below).

### Comment-vs-block policy

Cloudflare biases *explicitly toward approval*: clean/trivial → approve; suggestion-level
→ approve-with-comments; only **critical/safety** → block. Quinn's
PASS→approve / WARN→comment / FAIL→request_changes maps almost exactly, and her live
distribution (COMMENT 51%, REQUEST_CHANGES 2.6%) confirms the correct bias. **Keep this.**

### Convergence — timeouts, not turn-limits

Cloudflare uses **per-task 5 min (10 for code quality), a 25 min overall cap, and a 60s
inactivity kill** plus heartbeat logs — and budget exhaustion still yields a *result*.
Quinn instead hits a raw LangGraph recursion cap (maxTurns=18 → 37 steps) and fails to
**nothing**, leaving the PR stuck. This is her clearest defect.

### Memory — recall → review → retain

Real but young. Cloudflare's production form is **re-review memory**: on re-review the
coordinator gets *"the full text of its last review comment and a list of inline DiffNote
comments… along with their resolution status,"* auto-resolves fixed findings, respects
"won't fix," reconsiders on "I disagree." Per-repo conventions ride in
[AGENTS.md injected into prompts](https://blog.buildbetter.ai/agents-md-complete-guide-for-engineering-teams-in-2026/).
A simpler [recall/retain loop](https://dev.to/abhiramcdivakaran/building-a-code-review-agent-that-learns-from-every-decision-5a4c)
stores `PR# | file | comment | developer-action` and suppresses repeatedly-rejected
suggestion types. **Honest caveat:** measured benefit is mostly *qualitative*
(*"the first review is average; the tenth is meaningfully better"*) — no published
precision/recall gains. Memory is a trust/consistency play, not a proven accuracy
multiplier.

**Quinn is fully stateless.** The highest-value memory is **re-review memory**, not a
fancy KB — she re-reviews the same PR from scratch every CI cycle, which both wastes
turns and is a prime cause of the recursion thrash.

### Evaluation

The field measures with **bug-hits vs valid-suggestions vs noise**
([CR-Bench / CR-Evaluator](https://arxiv.org/pdf/2603.11078)), **signal-to-noise ratio**
as a trust proxy, and **suggestion-acceptance rate**. Precision is the universal hard
part (some tools <10%). Quinn has no eval harness — but we already log
`quinn.review.submitted` + `autonomous.outcome.*pr_review` + GitHub resolution state, so
the raw material exists.

## Prioritized roadmap

**P0 — fix the stuck mode**
1. **Never fail to nothing.** On budget exhaustion (recursion limit / timeout) in a
   `pr_review` run, force-emit a terminal **COMMENT** ("review incomplete — out of budget;
   partial findings below") instead of a hard error. Removes the ~1.6% of PRs that get no
   verdict and stall the merge loop.
2. **Make clawpatch deterministic, not discretionary.** ✅ *grounded-trigger half shipped
   (#891).* `diff_summary` now computes the objective trigger (>3 files / >120 lines /
   sensitive path) from authoritative GitHub metrics — PR-JSON totals + full-diff paths,
   neither truncated — and emits an explicit `STRUCTURAL REVIEW REQUIRED` directive. This
   fixes the root defect: the model previously had to eyeball the trigger from a diff
   truncated at 200 lines, so on a large PR it was unevaluable and clawpatch under-fired.
   **Remaining phase-2:** hard-enforce (block the verdict until clawpatch ran on a
   REQUIRED diff) + measure the post-deploy firing rate via `scripts/quinn-review-eval.ts`
   before enforcing (enforcement risks re-opening the recursion-thrash mode #863 fixed).

**P1 — re-review memory** ✅ *shipped (prior-verdict recall)*
3. Before a re-review, recall Quinn's own prior verdict + which findings are resolved
   (Cloudflare's re-review contract). Cuts duplicate comments, tokens, and thrash.
   **Implemented** as a `pr_inspector(action='prior_review')` read-action: it fetches
   the reviewer bot's own latest formal verdict (state + body + reviewed SHA) and
   compares that SHA to the current head, so a re-review is incremental — reaffirm on
   an unchanged head (CI settling), or review only the delta when the head advanced —
   instead of a cold re-derivation. **GitHub-native by design** (no local memory store
   to drift): Quinn's findings live in the review *body*, so her prior verdict is the
   ground-truth recall, and the reviewed-vs-head SHA is the delta signal. This mirrors
   CodeRabbit's incremental model (*"consider all comments since the most recent review,
   review only the new changes"*) — the pipeline/orchestration angle, decoupled from the
   deterministic approve-on-green gate. The AgentMemory flywheel (a `memory:` block +
   PR-stable `contextId`) remains a separate future additive for *cross-PR* pattern
   learning, not same-PR re-review state.

**P2 — repo conventions + eval**
4. Per-repo conventions via AGENTS.md-style injected context, or wire Quinn into the
   existing `AgentMemory` flywheel (she's the one core agent without a `memory:` block)
   with a `review_finding` domain. Set expectations honestly (consistency, not precision).
5. Stand up an **eval harness** from data we already emit: per-finding resolution rate,
   SNR, verdict-vs-merge accuracy. Arguably do this *first* as the baseline.

**Keep (already at/above field):** the Step 2c grounding rule, deterministic
VERDICT→action mapping with CI-terminal gating (409→comment), approval-biased rubric,
self-review safety rail.

## Prompt-policy decision: "what NOT to flag"

The field's highest-ROI noise lever is an explicit **don't-flag exclusion list**. Our
house rule is *"prompts — no negative reinforcement / positive framing only."* These
appear to conflict.

**Decision:** carve the exception. The no-negative-reinforcement rule targets *behavioral
coaching* of the agent ("never be lazy", "don't hallucinate") — which degrades into
nagging. A **scope-exclusion list** ("the following finding categories are out of scope
for this review") is *specification*, not behavioral reinforcement: it defines the task
boundary the same way a function signature does. Review agents are the case where naming
the out-of-scope set is the single biggest signal-quality win, so Quinn's `pr_review`
prompt carries an explicit out-of-scope list. This is a deliberate, scoped exception, not
a repeal of the house rule.

## Specialization decision (#892): don't fan out — yet

Quinn is one ReAct agent wearing all hats; the production systems we benchmarked
([Cloudflare](https://blog.cloudflare.com/ai-code-review/)'s 7 scoped reviewers + coordinator,
Qodo 2.0's per-concern agents) fan out. The question this spike answers: is scoped
specialization worth building **at our scale and for our failure profile?**

**Decision: no fan-out now.** Build the cheaper levers first; revisit only if the eval
harness proves a residual catch-rate/SNR gap after them. Reasoning:

1. **Our measured failure was never "missed a bug for lack of specialization."** It was
   recursion thrash from busy-waiting CI (#863, fixed) and structural review under-firing
   (#891, now grounded). The one real quality gap — cross-file bugs — is a *context* gap,
   not a *number-of-reviewers* gap. [Greptile's 82% vs CodeRabbit's 44%](https://www.greptile.com/benchmarks)
   came from **whole-repo graph context**, not from multi-agent. Our own analog is
   clawpatch (structural/whole-tree), which is far cheaper per catch than N specialized
   LLM reviewers — so the catch-rate budget belongs there, not in fan-out.

2. **Cloudflare's win was mostly the coordinator's *reasonableness filter*, not the seven
   agents.** Their lift came from dropping *"speculative issues, nitpicks, false positives,
   and convention-contradicted findings"* and *reading source to verify*. Quinn already has
   the grounding half (the Step 2c EXISTS/MISSING rule) and the out-of-scope list. The
   remaining noise win is a **single self-critique "reasonableness" pass before the
   verdict** — one extra reasoning step in the existing agent, no fan-out, no new plumbing.

3. **Fan-out re-opens the exact surface we hardened against.** The `pr_review` skill
   deliberately *strips* delegation tools (`chat_with_agent` et al.) because they lured the
   ReAct loop into thrash on simple PRs. A coordinator that fans out to sub-reviewers
   contradicts that hard-won scoping unless done at the orchestration layer (a deterministic
   coordinator skill + N sub-skills + a synthesis step) — real new plumbing that multiplies
   per-review LLM cost by N and adds a synthesis round, for ~217 reviews/day.

4. **Cost is not free at this volume.** N-way fan-out at 217/day is ~217·N extra agent runs
   daily plus synthesis. That spend only earns out if it beats the cheaper levers on a
   *measured* SNR/catch-rate delta — which we cannot claim without the eval harness (P2 #5).

**So the ordered path is:** finish clawpatch (grounded → measured → enforced) · add a
single reasonableness self-critique pass · stand up the eval harness · **then** re-measure.
If a residual gap survives all of that, prefer **whole-repo context** (Greptile's lever,
matched to our cross-file bug class) over **more agents** (Cloudflare's lever), because
context addresses our actual failure and fan-out re-introduces the thrash risk. This is a
deliberate deferral backed by our failure data, not a rejection of specialization in
principle.

## Sources

- [Greptile — agent architecture](https://www.greptile.com/agent) · [benchmarks](https://www.greptile.com/benchmarks) · [Greptile vs CodeRabbit](https://www.greptile.com/greptile-vs-coderabbit)
- [Cloudflare — Orchestrating AI Code Review at scale](https://blog.cloudflare.com/ai-code-review/)
- [Propel — reducing AI code-review false positives](https://www.propelcode.ai/blog/ai-code-review-false-positives-reducing-noise) · [CodeAnt — FP tolerances](https://www.codeant.ai/blogs/ai-code-review-false-positives)
- [Building a code-review agent that learns from every decision](https://dev.to/abhiramcdivakaran/building-a-code-review-agent-that-learns-from-every-decision-5a4c) · [AGENTS.md guide](https://blog.buildbetter.ai/agents-md-complete-guide-for-engineering-teams-in-2026/)
- [CR-Bench — evaluating real-world utility of AI code-review agents](https://arxiv.org/pdf/2603.11078)
- [Qodo PR-Agent — compression strategy](https://qodo-merge-docs.qodo.ai/core-abilities/compression_strategy/) · [State of AI Code Review Tools 2025](https://www.devtoolsacademy.com/blog/state-of-ai-code-review-tools-2025/)
