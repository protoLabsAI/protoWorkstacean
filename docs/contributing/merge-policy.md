---
title: Merge policy + stacked PRs
---

## TL;DR

We allow all three merge modes (merge commit, squash, rebase). The rule:

| When | Use |
|---|---|
| One-off PR targeting `main` / `dev` | Squash (default) |
| Stacked PR (base is another PR's branch) | **Merge commit** |
| Anything else | Squash |

Plus one local git config change for everyone: `git config --global rebase.updateRefs true`.

---

## Why this matters

Squash-merge collapses a PR's commits into one new commit with a fresh SHA on dev. When PR B is stacked on PR A and A gets squash-merged, B's history still references A's original commits. Git's rebase algorithm can't tell which commits are "already on dev as part of the squash" vs "still need to apply" — so it tries to re-apply them, hitting conflicts that should have been mechanical.

Merge commits don't have this problem. The original commit SHAs are preserved on dev, so when you rebase the next stacked PR, git correctly identifies what's already upstream.

---

## Step 1 — Org-level settings (admin)

One-time. Affects defaults for new repos.

1. Go to `https://github.com/organizations/protoLabsAI/settings/member_privileges`
2. Scroll to **Repository defaults → Pull Requests**
3. Under **Allow merge button options**, check all three:
   - ☑ Allow merge commits
   - ☑ Allow squash merging
   - ☑ Allow rebase merging
4. Leave the **default merge button** as **Squash** (matches today's behaviour for non-stacked PRs)
5. Click **Save**

New repos inherit these defaults. Existing repos keep whatever they had — fix those in Step 2.

---

## Step 2 — Repo-level settings (admin, per repo)

Do this on every active repo where stacking happens.

1. Go to `https://github.com/protoLabsAI/<repo>/settings`
2. Scroll to **Pull Requests** section
3. Under **Allow merge commits**:
   - ☑ Enable
   - Merge commit message: **Default to PR title** (keeps the merge commit readable)
4. Leave squash + rebase enabled too
5. Click **Save** at the bottom of the section

---

## Step 3 — Branch protection check (admin, per repo)

The rule differs by branch:

### `dev` — linear history must be OFF

1. Go to `https://github.com/protoLabsAI/<repo>/settings/branches`
2. Open the rule for `dev`
3. **Verify "Require linear history" is OFF**
   - If it's ON, merge commits are forbidden on dev regardless of the merge-button settings — uncheck it.

This is what makes the merge-commit-for-stacks workflow actually work. Stacked PRs target `dev`; if dev forbids merge commits, the policy can't be applied.

### `main` — linear history stays ON (intentional)

`main` is the release branch. Each commit on `main` should be one release.

1. **Leave "Require linear history" ON** for `main`
2. Promotion PRs (`dev → main`) get squashed or rebased into a single release commit, which is what we want
3. The detailed per-PR history stays on `dev` where it's useful for debugging; main stays a clean tagged log

**Do not flip this OFF thinking it's required by the merge-commit policy.** The policy only applies to PRs targeting `dev`. Promotion PRs are inherently single-unit work and benefit from being squashed.

### Everything else

Required status checks, required reviews — leave as-is. Both `dev` and `main` keep the same check requirements.

---

## Step 4 — Local git config (everyone)

One-time, on your machine.

```bash
git config --global rebase.updateRefs true
```

This single setting saves most of the manual stack-rebase work. When you `git rebase` one branch, git automatically moves dependent branch refs forward.

Verify:

```bash
git config --global --get rebase.updateRefs
# should print: true
```

---

## Step 5 — The workflow rule

For everyone, every PR:

- **If your PR's base is `main` or `dev`** (one-off PR): click **Squash and merge** (the default).
- **If your PR's base is another PR's branch** (stacked PR): click the dropdown next to the merge button and pick **Create a merge commit** instead.

### How to recognize a stacked PR

The PR header on GitHub shows the base branch:

```
chore/foo wants to merge 3 commits into chore/bar
```

If you see anything other than `main` or `dev` after "into," it's a stacked PR — use merge commit.

---

## Step 6 — Stack hygiene

If you're the one stacking PRs, two habits make life easier:

1. **Don't enable auto-merge until the entire stack has stopped moving.** Auto-merge captures the head SHA at the moment you click it. If you then rebase the branch, auto-merge fires against the old SHA and skips your new commits.
2. **When dev advances, rebase the bottom of your stack first**, then let `rebase.updateRefs` cascade the change to the dependents. If a conflict in the middle of the stack forces a manual rebase, use `git rebase --onto <new-base> <old-base>` rather than relying on git's default upstream-detection — the default gets confused with merged-and-squashed predecessors.

---

## Reading the resulting history

Merge commits aren't noise if you read with the right flag:

```bash
# Default — sees every commit including merge-commit branches
git log

# Just the main-line PRs (one entry per merged PR; same view as squash-only)
git log --first-parent main

# Same but a graph
git log --first-parent --graph --oneline main
```

Set an alias so it's one keystroke:

```bash
git config --global alias.mlog "log --first-parent --graph --oneline"
# usage: git mlog main
```

---

## FAQ

**Q: Why not just use rebase-merge for stacked PRs?**

Rebase-merge rewrites the parent pointers of every commit in the PR, generating new SHAs. Same root problem as squash from a stacking perspective — the next PR in the stack can't recognize what's already upstream. Only merge commits preserve SHAs.

**Q: Won't this make `git blame` worse?**

No. `git blame` always walks the commit graph regardless of merge style. Merge commits are transparent to it.

**Q: Won't the main branch's commit count balloon?**

Yes, the raw count goes up because individual commits aren't squashed. But `git log --first-parent` gives you the squashed view whenever you want it, and tooling (the GitHub UI, IDE git panels) generally shows what you'd expect.

**Q: What if I disagree and want to keep squashing my stacked PRs?**

You'll burn an hour every time the stack rebases. The policy lets you make that call but the team default is merge commit for stacks.

**Q: Are there tools that automate this further?**

Yes — see [`git-spice`](https://abhinav.github.io/git-spice/), [`git-branchless`](https://github.com/arxanas/git-branchless), or [`spr`](https://github.com/ejoffe/spr). All open-source. Not required, but they make stacks meaningfully nicer if you do them often. Graphite is the paid equivalent.

---

## Rollout checklist

- [ ] Admin: org settings updated (Step 1)
- [ ] Admin: repo settings updated for `protoWorkstacean` (Step 2)
- [ ] Admin: branch protection verified on `main` and `dev` (Step 3)
- [ ] Admin: repo settings + branch protection done for other active repos
- [ ] Everyone: `rebase.updateRefs` set locally (Step 4)
- [ ] Team: briefed on the merge-button rule (Step 5)
