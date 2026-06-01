---
description: Promote code from dev to main with automatic version bump and release. No staging branch — this repo uses feature -> dev -> main.
category: engineering
argument-hint: [dev-to-main]
allowed-tools:
  - Bash
  - Read
  - Glob
  - Grep
  - Agent
---

# /promote — Release Promotion Pipeline

You are the release promotion operator for protoWorkstacean. Your job is to move code safely through the `dev -> main` pipeline.

## Release Pipeline Architecture

Version bumps happen on **dev** before promotion to main.
This eliminates sync-back conflicts entirely.

```
dev -> [prepare-release bumps version on dev] -> dev->main PR -> auto-release tags main
```

- `prepare-release.yml` — bumps version on dev based on conventional commits
- `auto-release.yml` — tags main and creates GitHub Release after merge, then syncs back to dev

## Workflow

### 1. Pre-flight checks

```bash
git fetch origin dev main
```

Check divergence between dev and main:

```bash
git log --oneline origin/main..origin/dev   # what we're promoting
git log --oneline origin/dev..origin/main   # what main has that dev doesn't
```

If main has commits dev doesn't, a sync merge is needed (see step 2).

### 2. Sync merge (if needed)

When main has commits that dev doesn't:

1. Create a sync branch from dev:

   ```bash
   git checkout -b chore/sync-main-into-dev-$(date +%s) origin/dev
   ```

2. Merge main into it:

   ```bash
   git merge origin/main
   ```

3. If conflicts arise (typically in `package.json`):
   - **version field**: Take the HIGHER semver
   - Other fields: keep existing dev content

4. Commit and push the sync branch
5. Create and auto-merge a PR targeting `dev`
6. Wait for it to merge (poll every 10s, max 5 min)

### 3. Run prepare-release

Before creating the dev→main promotion PR, trigger the version bump on dev:

```bash
gh workflow run prepare-release.yml --ref dev --repo protoLabsAI/protoWorkstacean
```

Wait for the workflow to complete:

```bash
# Poll every 15s, max 5 min
for i in $(seq 1 20); do
  STATUS=$(gh run list --workflow=prepare-release.yml --repo protoLabsAI/protoWorkstacean --limit 1 --json status --jq '.[0].status')
  if [ "$STATUS" = "completed" ]; then
    echo "prepare-release completed."
    break
  fi
  echo "  Waiting for prepare-release... (${i}/20)"
  sleep 15
done
```

Check the run conclusion:

```bash
CONCLUSION=$(gh run list --workflow=prepare-release.yml --repo protoLabsAI/protoWorkstacean --limit 1 --json conclusion --jq '.[0].conclusion')
if [ "$CONCLUSION" != "success" ]; then
  echo "ERROR: prepare-release failed (conclusion: $CONCLUSION)"
  exit 1
fi
```

Then fetch the updated dev:

```bash
git fetch origin dev
```

### 4. Create the promotion PR

```bash
COMMITS=$(git log --oneline origin/main..origin/dev | head -20)
gh pr create --base main --head dev \
  --repo protoLabsAI/protoWorkstacean \
  --title "promote: dev -> main" \
  --body "## Summary
${COMMITS}

## Merge strategy
Use **merge commit** (not squash) per branch strategy."
```

### 5. Enable auto-merge

```bash
gh pr merge <NUMBER> --auto --merge --repo protoLabsAI/protoWorkstacean
```

### 6. Monitor CI

```bash
gh pr checks <NUMBER> --watch --repo protoLabsAI/protoWorkstacean
```

Report the final status. If all checks pass and auto-merge fires, report success.

### 7. Post-merge

`auto-release.yml` fires automatically, tags the version, creates the GitHub Release, and syncs main back to dev. No additional action needed.

## Error handling

- If prepare-release fails: report the workflow run URL, do not proceed with promotion
- If a sync PR fails CI: report the failure URL, do not proceed with promotion
- If the promotion PR has conflicts after sync: unexpected divergence — report and stop
- If CI fails on the promotion PR: report which check failed and the URL
- Never force-push or use `--no-verify`

## Example session

```
User: /promote

Agent: Fetching branches...
  dev is 7 commits ahead of main.
  No divergence — clean promotion.
  Triggering prepare-release on dev...
  prepare-release completed — v0.8.0 bumped on dev.
  Creating promotion PR: dev -> main...
  PR #185 created: https://github.com/protoLabsAI/protoWorkstacean/pull/185
  Auto-merge enabled. Watching CI...
  All checks passed. PR auto-merged.
  auto-release.yml will tag v0.8.0 and create the GitHub Release.
```
