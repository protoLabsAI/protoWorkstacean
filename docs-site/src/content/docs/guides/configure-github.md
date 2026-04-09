---
title: GitHub Plugin
---

# GitHub Plugin

Receives GitHub webhook events and routes `@mention` comments to the agent fleet. Agent replies are posted back as GitHub comments.

## How It Works

```
@quinn comment on issue/PR
  → GitHub sends POST /webhook/github
    → GitHubPlugin validates HMAC-SHA256 signature
      → Publishes message.inbound.github.{owner}.{repo}.{event}.{number}
        → RouterPlugin routes to Quinn (skillHint: bug_triage / pr_review)
          → Quinn processes and responds
            → RouterPlugin publishes message.outbound.github.{owner}.{repo}.{number}
              → GitHubPlugin posts reply as GitHub comment
```

## Setup

### 1. Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `GITHUB_TOKEN` | Yes | PAT used to post comment replies (enables the plugin) |
| `GITHUB_WEBHOOK_SECRET` | Recommended | Validates `X-Hub-Signature-256` on inbound payloads |
| `GITHUB_WEBHOOK_PORT` | No | Port for the webhook HTTP server (default: `8082`) |

The plugin is automatically skipped if `GITHUB_TOKEN` is not set.

### 2. github.yaml

Place a `github.yaml` in your workspace directory (default: `workspace/github.yaml`). If absent, the plugin loads with built-in defaults.

```yaml
# Handle to watch for in comments. Case-insensitive match.
mentionHandle: "@quinn"

# Skill routed to per GitHub event type.
# Becomes the skillHint on the bus message — tells RouterPlugin which agent to call.
skillHints:
  issue_comment: bug_triage              # @mention in a comment on an issue
  issues: bug_triage                     # @mention in the body of a new issue
  pull_request_review_comment: pr_review # @mention in a PR review comment
  pull_request: pr_review                # @mention in a PR description
```

### 3. Register the Webhook in GitHub

In your repo: **Settings → Webhooks → Add webhook**

| Field | Value |
|-------|-------|
| Payload URL | `https://hooks.proto-labs.ai/webhook/github` |
| Content type | `application/json` |
| Secret | Value of `GITHUB_WEBHOOK_SECRET` |
| SSL verification | Enable |
| Events | Issue comments, Issues, Pull request review comments, Pull requests |

### 4. GitHub Token Permissions

Fine-grained PAT scoped to the target repo:

| Permission | Level |
|------------|-------|
| Issues | Read & Write |
| Pull requests | Read & Write |
| Actions | Read |
| Contents | Read |

## Bus Topics

| Topic | Direction | Description |
|-------|-----------|-------------|
| `message.inbound.github.{owner}.{repo}.{event}.{number}` | Inbound | @mention received |
| `message.outbound.github.{owner}.{repo}.{number}` | Outbound | Reply to post as comment |

## Inbound Payload

```typescript
{
  sender: string;       // GitHub username of the commenter
  channel: string;      // "{owner}/{repo}#{number}" — stable context key for A2A
  content: string;      // Full context string: event header + title + author + URL + body
  skillHint?: string;   // From github.yaml skillHints (e.g. "bug_triage", "pr_review")
  github: {
    event: string;      // GitHub event type (issue_comment, pull_request, etc.)
    owner: string;
    repo: string;
    number: number;     // Issue or PR number
    title: string;
    url: string;        // Direct URL to the comment
  };
}
```

## Outbound Payload

```typescript
{
  content: string;  // Text to post as a GitHub comment
}
```

Match `correlationId` from the inbound message — the plugin uses it to look up the pending comment context (owner, repo, number).

## Supported Events

| GitHub Event | Trigger | Default Skill |
|-------------|---------|---------------|
| `issue_comment` | Comment containing `@mention` on an issue | `bug_triage` |
| `issues` | New issue body containing `@mention` | `bug_triage` |
| `pull_request_review_comment` | Review comment containing `@mention` | `pr_review` |
| `pull_request` | PR opened/updated with `@mention` in body | `pr_review` |
| `repository` (created) | New repository created in the org | `message.inbound.onboard` |

## Org Webhook: repository.created

When a new repository is created in the GitHub org, the plugin publishes `message.inbound.onboard` so Ava (or any subscriber) can automatically onboard the project.

### Onboard Bus Payload

```typescript
{
  event: "repository.created";
  owner: string;       // org or user name
  repo: string;        // repository name
  fullName: string;    // "owner/repo"
  url: string;         // HTML URL of the repository
  description: string; // repository description (empty string if none)
  isPrivate: boolean;
}
```

Topic: `message.inbound.onboard`

### Register the Org Webhook

Register a single org-level webhook so all new repositories trigger the event automatically — no per-repo webhook needed.

```bash
gh api orgs/protoLabsAI/hooks \
  --method POST \
  --field name=web \
  --field "config[url]=https://hooks.proto-labs.ai/webhook/github" \
  --field "config[content_type]=json" \
  --field "config[secret]=$GITHUB_WEBHOOK_SECRET" \
  --field "config[insecure_ssl]=0" \
  --field "events[]=repository"
```

To also receive existing repo events (issues, PRs) via the org hook, add them:

```bash
  --field "events[]=repository" \
  --field "events[]=issues" \
  --field "events[]=issue_comment" \
  --field "events[]=pull_request" \
  --field "events[]=pull_request_review_comment"
```

List existing org hooks:
```bash
gh api orgs/protoLabsAI/hooks
```

## Signature Validation

Requests are validated against `X-Hub-Signature-256` using HMAC-SHA256 with `GITHUB_WEBHOOK_SECRET`. Requests with invalid or missing signatures are rejected with `401`.

If `GITHUB_WEBHOOK_SECRET` is not set, signature validation is skipped (not recommended for production).
