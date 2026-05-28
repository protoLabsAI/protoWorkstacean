---
title: "ADR-0001: Org-to-execution pipeline"
---

# ADR-0001: Org-to-execution pipeline

- **Status:** Accepted — 2026-05-27
- **Deciders:** Josh (operator)
- **Related:** [ADR-0002](./0002-workstacean-protomaker-integration-boundary), [ADR-0003](./0003-content-surfacing-into-protocontent), protoMaker#3975

## Context

The protoLabs fleet needs a single, legible path from a high-level idea to executed engineering work across multiple projects. The moving parts:

- **Linear** — where org/portfolio planning happens.
- **protoWorkstacean** — the switchboard; hosts Ava (helm) and Quinn (QA).
- **protoMaker** — the engineering-project system; owns project boards, decomposition, and per-project execution (auto-mode / proto / the per-project **Roxy** PM agent).
- **GitHub** — where issues and PRs live.

Earlier drafts had Ava decomposing an initiative into per-repo GitHub issues herself. That puts decomposition in the wrong place and makes Ava fat.

## Decision

A two-tier pipeline with a strict separation of responsibilities.

**Roles:**

- **Linear = org/portfolio planning.** It holds *initiatives*, not granular engineering tickets. Granular engineering work never has its terminal home in Linear.
- **Ava (protoWorkstacean) = portfolio manager.** She receives intake, decides which project it belongs to, and **forwards**. She does **not** decompose.
- **protoMaker = decomposition + execution.** It turns an initiative into **project → epics → milestones → features**, and drives the work (Roxy as per-project PM, proto as hands).
- **Quinn (protoWorkstacean) = QA gate** on the resulting PRs.

**Two intakes, coexisting:**

1. **Initiative-level (create-project).** A Linear ticket *assigned to the Ava agent* is the trigger. Ava forwards it into protoMaker's **create-project intake**. protoMaker creates the project and decomposes it into epics → milestones → features. Use for new projects / substantial initiatives.
2. **Issue-level (incremental).** A GitHub issue on a project's repo → protoMaker's webhook ingestion → a backlog `idea` on *that project's* board. Use for incremental work on existing projects. Keystone: **protoMaker#3975** (route issues to the right project by repo, not a default).

**Reporting flows back up:** protoMaker → protoWorkstacean via `POST /publish` (`feature.completed` / `feature.failed`); GitHub → `release.published`; Quinn audits PRs and reports verdicts. protoWorkstacean's scheduler + GitHub reads provide the check-in loop that keeps in-progress work unblocked.

## Consequences

- Ava stays thin: routing and forwarding, never decomposition. Decomposition hierarchy is owned in one place (protoMaker).
- Linear stays high-level; we don't pollute the org layer with engineering features. (This is why an engineering task filed as a Linear ticket gets re-homed, not kept.)
- Net-new work this implies: a **create-project intake** on protoMaker (initiative-level) and **#3975** (issue-level routing). Delivery mechanism is set by [ADR-0002](./0002-workstacean-protomaker-integration-boundary).
- The fleet is dogfooded: the build-out of this pipeline is itself tracked in the Linear "Portfolio fan-out" project.
