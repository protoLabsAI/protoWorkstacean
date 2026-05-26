---
title: Flow — PR review pipeline
---

_Quinn reviews every PR opened against fleet repos. GitHub webhook → dispatch with `skillHint=pr_review` → Quinn issues a verdict (PASS / WARN / FAIL) via tool call → GitHub review (APPROVED / COMMENTED / CHANGES_REQUESTED). The self-cascade guard prevents agent-authored PRs from re-triggering the loop._

---

## What & why

GitHub PR events arrive on the same `message.inbound.github.*` topic as everything else, but with `skillHint=pr_review` pinned by `GitHubPlugin._handleAutoReview` ([github.ts:566–581](../../lib/plugins/github.ts)). That hint guarantees `pr_review` is dispatched even if RouterPlugin's keyword table would have routed elsewhere.

Quinn's executor (DeepAgent) executes `pr_review` and decides one of three verdicts via tool call:

| Quinn tool call | GitHub review event |
|---|---|
| `review_approve` | APPROVED |
| `review_comment` | COMMENTED |
| `review_request_changes` | CHANGES_REQUESTED |

The verdict tool call publishes to `message.outbound.github.{owner}.{repo}.{number}` and GitHubPlugin posts to the GitHub API.

---

## ASCII spine

```
   GitHub PR webhook
        │
        ▼
   ┌──────────────────────────┐
   │ GitHubPlugin             │  ← self-cascade guard:
   │  _handleAutoReview()     │     drop if author ∈ {protoquinn[bot],
   │                          │       ava[bot], protobot[bot], …}
   │                          │     for non-PR events only
   │  dedup window 60s        │  ← drop duplicate PR pushes within window
   └──────────────┬───────────┘
                  │
                  ▼
   ┌──────────────────────────┐
   │ message.inbound.github.  │  payload: { skillHint: "pr_review",
   │   {owner}.{repo}.        │             reply.topic: outbound.github.… }
   │   pull_request.{n}       │
   └──────────────┬───────────┘
                  │
                  ▼  RouterPlugin (pass-through, skillHint wins)
                  ▼
   ┌──────────────────────────┐
   │  agent.skill.request     │  skill: pr_review
   │                          │  targets: [quinn]
   └──────────────┬───────────┘
                  ▼
            SkillDispatcher  (cooldown 30s per-repo, see #437)
                  │
                  ▼
   ┌──────────────────────────┐
   │  Quinn (DeepAgent)       │  prompted: "Issue your verdict (PASS/WARN/FAIL)
   │                          │             via review_approve /
   │                          │             review_comment /
   │                          │             review_request_changes."
   └──────────────┬───────────┘
                  │ tool call
                  ▼
   ┌──────────────────────────┐
   │ message.outbound.github. │  payload: { type: "review_approve" | … ,
   │   {owner}.{repo}.{n}     │             body, event }
   └──────────────┬───────────┘
                  ▼
            GitHubPlugin._postComment()
                  │
                  ▼
            GitHub REST API
        POST /repos/{owner}/{repo}/pulls/{n}/reviews
```

---

## Sequence

```mermaid
sequenceDiagram
    autonumber
    participant GH as GitHub
    participant GP as GitHubPlugin
    participant Bus as Bus
    participant R as RouterPlugin
    participant SD as SkillDispatcher
    participant Q as Quinn (DeepAgent)

    GH->>GP: webhook (pull_request.opened / synchronize / review_requested)

    rect rgb(240, 230, 220)
        Note over GP: webhook-time filters
        GP->>GP: self-cascade guard (bot login filter)
        GP->>GP: dedup window 60s
    end

    GP->>Bus: message.inbound.github.{o}.{r}.pull_request.{n}<br/>(skillHint=pr_review)
    Bus->>R: deliver
    R->>Bus: agent.skill.request<br/>(skill=pr_review, targets=[quinn])
    Bus->>SD: deliver

    rect rgb(240, 230, 220)
        Note over SD: dispatcher chokepoint<br/>cooldown 30s per-repo
    end

    SD->>Q: execute(req)
    Q->>Q: read PR diff via tools
    Q->>Q: analyze (LLM)

    alt PASS
        Q->>Bus: review_approve tool call → message.outbound.github.{o}.{r}.{n}
    else WARN
        Q->>Bus: review_comment tool call → message.outbound.github.{o}.{r}.{n}
    else FAIL
        Q->>Bus: review_request_changes tool call → message.outbound.github.{o}.{r}.{n}
    end

    Bus->>GP: deliver outbound (correlationId match in pendingComments)
    GP->>GH: POST /repos/{o}/{r}/pulls/{n}/reviews
```

---

## Bus topic table

| Topic | Published by | Subscribed by | File:line |
|---|---|---|---|
| `message.inbound.github.{o}.{r}.pull_request.{n}` | GitHubPlugin._handleAutoReview | RouterPlugin | `lib/plugins/github.ts:697,632` |
| `agent.skill.request` (skill=pr_review) | RouterPlugin (re-emits with target) | SkillDispatcher | `src/router/router-plugin.ts:272` |
| `agent.skill.response.{correlationId}` | SkillDispatcher | GitHubPlugin (pendingComments match) | `src/executor/skill-dispatcher-plugin.ts:96,182,195` |
| `message.outbound.github.{o}.{r}.{n}` | Quinn (via tool call) | GitHubPlugin._postComment | `lib/plugins/github.ts:298,375` |
| `flow.item.{created,updated,completed}` | SkillDispatcher | telemetry / dashboard PR-1/2/3 tiles | `src/executor/skill-dispatcher-plugin.ts:275,370,418` |

---

## "PR-1 / PR-2 / PR-3" — what those phases mean

The dashboard's PR review tiles aren't pipeline *phases* — they're three **states** in the `flow.item` lifecycle, observed by [flow-dashboard](flow-dashboard.md):

- **PR-1** — `flow.item.created` (dispatch started, Quinn assigned)
- **PR-2** — `flow.item.updated` (Quinn running, may publish progress)
- **PR-3** — `flow.item.completed` (verdict posted, GitHub review created)

Each tile counts items in each state. There is **no formal phase boundary** in source — the names are dashboard nomenclature.

---

## Self-cascade guard

[github.ts:524–542](../../lib/plugins/github.ts) drops webhook events authored by known bots:

```
authorLogins to drop: protoquinn[bot], ava[bot], protobot[bot], …
```

**Critical:** PR events are *intentionally not filtered*. If Quinn opens a PR (e.g. autonomous tech-debt PR), Quinn still gets to review it. Filtering is only on issue/comment events — preventing Quinn → file issue → webhook → Quinn-files-another-issue cascade ([protoWorkstacean#556](https://github.com/protoLabsAI/protoWorkstacean/issues/556)).

---

## Dedup window

60s sliding window keyed by `(owner/repo, number)` ([github.ts:656](../../lib/plugins/github.ts)). Prevents fast-rebase floods (`git push --force` storms) from triggering N reviews. **Race:** if a real new commit lands within the 60s window, it doesn't trigger a review until the window clears. Acceptable today (PR review is best-effort, not real-time); revisit if it bites.

Note this is separate from #437 cooldown (which is per-skill-per-repo and 30s) — both apply, dedup at the webhook tier and cooldown at the dispatcher tier.

---

## Correlation ID chain

`correlationId` flows: webhook → inbound → router → dispatcher → outbound. GitHubPlugin stores `(owner, repo, number)` keyed by correlationId in `pendingComments` Map ([github.ts:621,683–684](../../lib/plugins/github.ts)) so the outbound subscriber knows which PR a reply belongs to.

**Fragile if dropped:** if any layer fails to forward `correlationId`, the reply still gets posted but to the wrong endpoint (or the lookup fails and it's orphaned). RouterPlugin and SkillDispatcher both preserve it by convention — but there's no enforcement.

---

## Failure modes & gotchas

- **Cooldown silently drops review #2 within 30s** — if a PR is opened and immediately rebased, the second event hits dispatcher cooldown and silently drops. Operator sees no review for the second push. Visible only in `console.warn`. See [chokepoint-invariants](chokepoint-invariants.md) re: missing dispatch-drop telemetry.
- **No timeout on Quinn's execution** — same as the general dispatcher gap; Quinn could hang indefinitely on a large diff. Mitigation: DeepAgent has its own `maxTurns` limit and per-tool timeouts.
- **Verdict tool calls are advisory** — Quinn could in principle issue no verdict (just a chat reply). The PR-review prompt instructs the verdict, but it's an LLM, not a formal contract. If no verdict is issued, GitHubPlugin posts the text response as a comment (default outbound path) and no formal review event is created on GitHub.
- **Self-cascade guard does NOT apply to PRs** — by design. Quinn-authored PRs *should* be reviewed. If Quinn ever starts auto-resolving its own reviews (approving her own PR), it would loop. Watch for that.

---

## Related

- [flow-inbound-message](flow-inbound-message.md) — the underlying transport
- [chokepoint-invariants](chokepoint-invariants.md) — #465 destructive-verdict guard, which sits inside `pr-remediator` (not Quinn), but related to the verdict pattern
- [flow-alert-remediator](flow-alert-remediator.md) — PR remediator handles `update_branch` / `fix_ci` / `address_feedback` actions that follow up on review verdicts
- [flow-dashboard](flow-dashboard.md) — PR-1/-2/-3 tiles
