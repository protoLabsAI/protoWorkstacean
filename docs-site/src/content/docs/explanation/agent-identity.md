---
title: Agent Identity — Multi-Bot Design and Per-Agent Tokens
---

# Agent Identity — Multi-Bot Design and Per-Agent Tokens

_This is an explanation doc. It explains why the fleet uses separate GitHub App identities per agent and how that affects message delivery._

---

## The problem: one server, multiple agent voices

protoWorkstacean routes messages to multiple agents — Quinn for code review and triage, Ava for features and planning, Frank for infrastructure. When these agents post responses back to GitHub, Discord, or Plane, they should appear as distinct identities. A Quinn review should show `protoquinn[bot]`, not a generic bot. An Ava feature creation comment should show `protoava[bot]`.

This matters because:
- **Attribution** — humans reading GitHub issues can tell at a glance whether Quinn or Ava made the observation
- **Filtering** — bots can be muted or filtered selectively
- **Trust signals** — a PR review from `protoquinn[bot]` carries the implicit context that this is a code-focused agent, not a general-purpose one

---

## How it works: GitHub App identities

Quinn and Ava each have their own GitHub App installation. Each app has an App ID and a private key (PKCS#1 PEM). The A2APlugin uses these to generate short-lived JWT tokens for GitHub API calls.

When A2APlugin receives a response from Quinn:
1. It looks up the GitHub context from the inbound `correlationId` (owner, repo, number)
2. It generates a JWT using `QUINN_APP_ID` + `QUINN_APP_PRIVATE_KEY`
3. It exchanges the JWT for a GitHub installation token
4. It posts the comment via the GitHub API — the comment appears as `protoquinn[bot]`

When Ava responds via a chain call (e.g., `bug_triage → ava/manage_feature`):
1. The same lookup happens for the GitHub context
2. Ava's comment is posted using `AVA_APP_ID` + `AVA_APP_PRIVATE_KEY`
3. The comment appears as `protoava[bot]`

If the GitHub App env vars are not set, comments fall back to the PAT (`GITHUB_TOKEN`), which posts as the PAT owner's account.

---

## Discord: single bot, multiple agents

Unlike GitHub, Discord does not have the concept of "apps posting as different bots." All Discord responses go through the single `DISCORD_BOT_TOKEN`. The agent identity in Discord is conveyed through message content and formatting rather than the posting identity.

The DiscordPlugin uses embed formatting to signal which agent responded. The agent name is included in the embed footer or prefix.

---

## Why Quinn handles Discord provisioning

The `onboard_project` skill is owned by Ava, but the `provision_discord` skill that creates Discord channels is owned by Quinn. This is a chain: Ava calls Quinn via `chain[onboard_project]: quinn/provision_discord`.

The reason is that Quinn has the Discord API client code and the knowledge of the standard channel structure (dev, alerts, releases). Ava handles the broader project provisioning logic (GitHub scaffold, Plane project creation, write-back to `projects.yaml`). The chain keeps these responsibilities separate.

When the channel IDs come back from Discord, they are written to both `settings.json` in the target repo and `projects.yaml` in the protoWorkstacean repo. This makes the IDs available to both the agent running in the target repo context and the workstacean routing layer.

---

## The `contextId` in A2A calls

Agent conversation memory is scoped by `contextId` in the JSON-RPC call:

```json
{
  "params": {
    "contextId": "workstacean-{channelId}"
  }
}
```

`contextId` is derived from the message channel. For Discord, it's the Discord channel ID. For GitHub, it's `{owner}/{repo}#{number}`. For Plane, it's the `correlationId` (`plane-{issueId}`).

This means:
- All messages in the same GitHub issue share a conversation thread in the agent's memory
- All messages in the same Discord channel share a thread
- The HITL resume flow (days later) uses the same `correlationId` as the original plan request — Ava's memory of the conversation is preserved across the approval gap

---

## Secrets management

All per-agent secrets live in Infisical (AI project `11e172e0`). The workstacean container receives them via `infisical run` at deploy time. The homelab-iac `docker-compose.yml` is the canonical reference for which secrets map to which services.

No secrets are stored in this repository. The `workspace/agents.yaml` file uses `apiKeyEnv` to reference the env var name (e.g., `AVA_API_KEY`), not the key value itself.

---

## Adding a new agent identity

1. Create a GitHub App in the target org (or as the org owner's personal app)
2. Generate a private key, download the PEM
3. Store `APP_ID` and `APP_PRIVATE_KEY` in Infisical
4. Add to `docker-compose.yml` as env vars for the `workstacean` service
5. Add `appId` and `appPrivateKeyEnv` fields to the agent entry in `workspace/agents.yaml`
6. Update the A2APlugin's comment posting logic to use the new app credentials for this agent's skill responses
