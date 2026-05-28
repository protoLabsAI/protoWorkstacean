---
title: "ADR-0003: Content surfacing into protoContent"
---

# ADR-0003: Content surfacing into protoContent

- **Status:** Accepted — 2026-05-27
- **Deciders:** Josh (operator)
- **Related:** [ADR-0001](./0001-org-to-execution-pipeline), [ADR-0002](./0002-workstacean-protomaker-integration-boundary)

## Context

**protoContent** is the Payload-CMS marketing hub + content pipeline (idea → outline → draft → cuts → schedule → publish → engage → capture). Brand voice lives there as data. We want fleet activity — shipped features, releases, milestones — to feed the content pipeline, without protoWorkstacean ever *generating* content (voice and authoring are protoContent's domain).

## Decision

**protoWorkstacean *surfaces* content ideas from fleet lifecycle events; it does not author content.** It feeds protoContent's `idea` stage and stops there.

- **`release.published` is the first tap and a first-class fleet primitive.** Sourced from GitHub's *native* `release` webhook (shipped in protoWorkstacean#644), so it fires regardless of how the release was cut (auto-release.yml, release-tools, or by hand). It is general-purpose — content is one subscriber among changelog aggregation, announce, and deploy verification.
- **A content-surfacing plugin** subscribes to content-worthy topics, normalizes a `ContentIdea` (`{ source, headline, whatHappened, links[], suggestedSurface, occurredAt }`), and POSTs it to protoContent's intake endpoint — HTTP, fire-and-forget, the same boundary discipline as [ADR-0002](./0002-workstacean-protomaker-integration-boundary).

**Which events to tap, tiered by signal strength:**

- **Tier 1 — "we shipped something":** `release.published`, `feature.completed`. Start here.
- **Tier 2 — narrative:** narrative `ceremony.*.completed` (weekly retro / standup digest), `autonomous.outcome.*` milestones (first autonomous merge, Nth feature).
- **Tier 3 — engage/capture:** community signal (Discord threads, GitHub discussions). Gate hard.
- **Do not tap:** `security.incident.reported` (sensitive), `feature.failed` / red CI (internal), raw `message.inbound.#` (firehose).

**Ideas are human-gated into the pipeline initially** — brand-voice stakes outweigh full automation until the loop is proven.

## Consequences

- Clean separation: protoWorkstacean surfaces, protoContent authors. No brand-voice logic leaks into the switchboard.
- Net-new work: a content intake endpoint on protoContent, and the content-surfacing plugin (gated on that endpoint).
- Operational: the GitHub App must subscribe to `release` events for `release.published` to fire.
- The same `release.published` primitive is reusable well beyond content — treat it as a lifecycle event, not a content-specific hook.
