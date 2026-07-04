---
title: How to Onboard a Project
---


_This is a how-to guide. It assumes the workstacean container is running and you have Ava configured in `workspace/agents/ava.yaml` (the in-process agent definition)._

---

Onboarding a project provisions it across every system protoLabs uses: GitHub (`.automaker/` scaffold) and Discord (category + channels created). The `onboard_project` skill on Ava orchestrates the full chain.

## Trigger options

### Option A — Automatic (org webhook)

If you have the GitHub org webhook registered (see [how-to/use-quinn-pr-review.md](use-quinn-pr-review) for webhook setup), any new repository created under the org automatically triggers onboarding. No manual action needed.

### Option B — Discord slash command

In any Discord channel the bot has access to:

```
/ava onboard
```

Or by @mention:

```
@YourBot onboard protoLabsAI/my-new-repo
```

### Option C — Bus injection (scripted/CI)

```bash
curl -s -X POST http://workstacean:3000/publish \
  -H "Content-Type: application/json" \
  -d '{
    "topic": "message.inbound.test",
    "payload": {
      "sender": "ci",
      "content": "onboard protoLabsAI/my-new-repo",
      "skillHint": "onboard_project",
      "channel": "cli"
    }
  }'
```

---

## What the onboard chain does

Ava's `onboard_project` skill runs these steps in sequence:

1. **GitHub API** — fetches repo metadata (description, topics, visibility)
2. **`.automaker/` scaffold** — writes `project.json` and `settings.json` into the target repo, commits and pushes
3. **`.gitignore` + worktree init** — adds worktree paths to `.gitignore` in the target repo
4. **Discord provisioning** — calls Quinn's `provision_discord` skill (via chain), which creates a Discord category with three channels: `dev`, `alerts`, `releases`
5. **Write-back** — stores Discord channel IDs in `.automaker/settings.json` (in the target repo)

Project metadata itself comes from the **project registry**, which is compiled from repos tagged with the `protoagent-plugin` GitHub topic (plus an explicit base set) into a static `projects.json` served by the `workstacean-projects` nginx sidecar at `/api/settings/global`; workstacean's `ProjectRegistry` polls that URL every 5 min. To add a project to the registry, tag its repo with the `protoagent-plugin` topic — the 15-min sync cron picks it up. The workstacean-side channel→agent bindings live in `workspace/channels.yaml` via the `ChannelRegistry` — onboarding does **not** write a `workspace/projects.yaml` (that file no longer exists). To make slash-commands resolve "the dev channel for this project", add a per-project binding to `workspace/channels.yaml`:

```yaml
- id: project-my-new-repo-dev
  platform: discord
  project: my-new-repo        # project slug
  kind: dev
  channelId: "<channel-id>"
```

On completion, a summary message is sent to the originating interface (Discord channel or the bus outbound topic).

---

## Verifying the onboard completed

Confirm the project shows up in workstacean's registry (compiled from the `protoagent-plugin` GitHub topic):

```bash
curl -s http://workstacean:3000/api/projects | jq '.data[] | select(.github.repo == "my-new-repo")'
```

Check the target repo for a `.automaker/` directory:

```bash
gh api repos/protoLabsAI/my-new-repo/contents/.automaker/project.json
```

If you added a per-project Discord binding, confirm it resolves via the
`ChannelRegistry` — the dev channel is keyed by `(slug, "dev")` in
`workspace/channels.yaml`.

---

## If provisioning fails partway through

The onboard chain is not atomic. If Discord provisioning fails (e.g., bot permissions), the `.automaker/` scaffold is still created. The error is logged and a partial-onboard notice is sent to the originating interface.

To re-run Discord provisioning only:

```bash
curl -s -X POST http://workstacean:3000/publish \
  -H "Content-Type: application/json" \
  -d '{
    "topic": "message.inbound.test",
    "payload": {
      "sender": "manual",
      "content": "provision discord for protoLabsAI/my-new-repo",
      "skillHint": "provision_discord"
    }
  }'
```

---

## Related docs

- [reference/agent-skills.md](../reference/agent-skills) — full skill registry including `onboard_project` parameters
- [reference/config-files.md](../reference/config-files) — workspace config + project registry
- [explanation/agent-identity.md](../explanation/agent-identity) — why Quinn handles Discord provisioning (not Ava)
