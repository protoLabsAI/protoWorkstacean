---
title: How to Use Quinn for PR Review
---


_This is a how-to guide. It covers webhook setup, triggering PR review, and understanding Quinn's vector context pipeline._

---

Quinn reviews pull requests and issues via GitHub webhook. It uses codebase-wide vector search (Qdrant + gateway qwen3-embedding) to provide context-aware reviews informed by past PR decisions and code patterns.

---

## 1. Set environment variables

| Variable | Required | Description |
|----------|----------|-------------|
| `GITHUB_TOKEN` | Yes | PAT — enables the GitHub plugin and posts comment replies |
| `GITHUB_WEBHOOK_SECRET` | Recommended | Validates `X-Hub-Signature-256` on inbound payloads |
| `GITHUB_WEBHOOK_PORT` | No | Webhook HTTP server port (default: `8082`) |
| `GITHUB_APP_ID` | For bot comments | GitHub App ID — Quinn posts as `protoquinn[bot]` |
| `GITHUB_APP_PRIVATE_KEY` | For bot comments | GitHub App private key (PKCS#1 PEM) |
| `QDRANT_URL` | For vector context | `http://qdrant:6333` |
| `EMBED_MODEL` | For embeddings | `qwen3-embedding` |
| `LLM_GATEWAY_URL` | For embeddings | `http://gateway:4000/v1` |

---

## 2. Configure github.yaml

```yaml
# workspace/github.yaml
mentionHandle: "@protoquinn"   # case-insensitive

skillHints:
  issue_comment: bug_triage              # @mention in a comment on an issue
  issues: bug_triage                     # @mention in the body of a new issue
  pull_request_review_comment: pr_review # @mention in a PR review comment
  pull_request: pr_review                # @mention in a PR description
```

---

## 3. Register the webhook in GitHub

For a single repository: **Settings → Webhooks → Add webhook**

| Field | Value |
|-------|-------|
| Payload URL | `https://hooks.proto-labs.ai/webhook/github` |
| Content type | `application/json` |
| Secret | Value of `GITHUB_WEBHOOK_SECRET` |
| SSL verification | Enable |
| Events | Issue comments, Issues, Pull request review comments, Pull requests, **Workflow runs**, **Check suites** |

> **Workflow runs + Check suites are required for the CI-completion re-review** (#721): Quinn posts a provisional `COMMENT` while CI is in flight and only upgrades to a formal `APPROVE`/`REQUEST_CHANGES` once every check is terminal. Without these two events nothing re-invokes Quinn when CI finishes, so clean PRs stall at the provisional comment. If you registered the webhook before 2026-06, **edit the existing hook to add them** (`PATCH orgs/protoLabsAI/hooks/<id>` with the full events list).

### Org-level webhook (recommended)

Register once at the org level to cover all repos — including new ones automatically:

```bash
gh api orgs/protoLabsAI/hooks \
  --method POST \
  --field name=web \
  --field "config[url]=https://hooks.proto-labs.ai/webhook/github" \
  --field "config[content_type]=json" \
  --field "config[secret]=$GITHUB_WEBHOOK_SECRET" \
  --field "config[insecure_ssl]=0" \
  --field "events[]=repository" \
  --field "events[]=issues" \
  --field "events[]=issue_comment" \
  --field "events[]=pull_request" \
  --field "events[]=pull_request_review_comment" \
  --field "events[]=workflow_run" \
  --field "events[]=check_suite"
```

---

## 4. Required GitHub token permissions

Fine-grained PAT scoped to the target repo:

| Permission | Level |
|------------|-------|
| Issues | Read & Write |
| Pull requests | Read & Write |
| Actions | Read |
| Checks | Read |
| Contents | Read |

> **Checks: Read** backs the CI-completion re-review's terminal gate (#721) — Quinn reads `commits/{sha}/check-runs` to confirm every check has finished before posting a formal verdict. If it's missing the gate fails *open* (Quinn still re-reviews, just without waiting for full terminality).

---

## 5. Trigger a PR review

### Automatic (recommended)

When a PR is opened or synchronized, and `pull_request` is in the webhook event list, Quinn reviews it automatically — no @mention needed.

### Manual via @mention

Leave a comment on any issue or PR:

```
@protoquinn please review this PR — focus on the auth changes
```

Quinn responds with a review comment posted as `protoquinn[bot]`.

### Manual via Discord slash command

```
/quinn review
```

With the `pr_review` skillHint, `RouterPlugin` publishes an `agent.skill.request` that `SkillDispatcherPlugin` routes to Quinn's `pr_review` skill on its in-process `DeepAgentExecutor`. Quinn runs inside the workstacean process — there is no A2A hop.

---

## 6. How Quinn's review works

Quinn's review goes beyond the diff. For every PR:

1. **Diff parsed** — file changes are chunked by `diff/chunker.ts`
2. **Symbols extracted** — TypeScript, Python, and Go symbols identified from the diff
3. **Vector search (parallel)**:
   - `quinn-pr-history` collection: past PR decisions for the same files
   - `quinn-code-patterns` collection: similar code patterns in the codebase
4. **Token budget enforced** — codebase context capped at 20% of the total prompt token budget
5. **Review prompt assembled** — diff + `CODEBASE CONTEXT` block + review instructions
6. **LLM call** — Quinn generates the review
7. **Comment posted** — as `protoquinn[bot]` on the PR

### Learning loop

When a developer dismisses a Quinn comment, the plugin records the dismissal in `quinn-review-learnings`. Over time, low-signal comment patterns are filtered out.

### Fallback

If Qdrant is unavailable, Quinn reviews from the diff alone (no vector context). The review still runs — no error is surfaced.

---

## 7. Bug triage flywheel

Reacting to any GitHub issue comment with 📋 triggers `bug_triage`:

```
/quinn comment on GitHub issue
  → Quinn (bug_triage): classifies bug, may file a tracking issue via file_bug tool
    → posts triage comment to GitHub issue
```

Trigger by @mention: `@protoquinn <description>` (admin users only).

---

## Related docs

- [reference/plugins.md](../reference/plugins) — GitHubPlugin API contract
- [reference/bus-topics.md](../reference/bus-topics) — GitHub bus topics
- [reference/agent-skills.md](../reference/agent-skills) — `pr_review` and `bug_triage` skill specs
- [explanation/architecture.md](../explanation/architecture) — Quinn's vector context pipeline in detail
