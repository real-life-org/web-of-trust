# Pipeline Responsibilities

Status: operational, non-normative.

This document is the project's **Agent Registry**: a governed catalog of every agent and human in the workflow, what they do, what they may decide, and where their authority ends. When in doubt about who decides or who acts, this document is the reference.

## Reality Check

At any given time, one human is the primary maintainer (currently Anton, full-time). Other humans contribute in phases, with their availability and scope changing over weeks or months. The pipeline must work with one engaged human and degrade gracefully when others are absent.

This document therefore describes **roles**, not people. The "Current Contributors" section at the end lists who fills which role today; that section is expected to drift as the team and project evolve.

## Roles

### Primary Maintainer

The default holder of every responsibility not explicitly delegated.

- Authors normative documents in the sibling `wot-spec/` repository. Synchronously, with AI assistance — see Hard Rule 1.
- Owns architecture decisions: `../wot-spec/IMPLEMENTATION-ARCHITECTURE.md`, layer boundaries, SDK boundaries.
- Holds the merge gate: every PR merge is a human click.
- Resolves conflicts when agent reviewers disagree (`needs-discussion` label).
- Owns the pipeline configuration: scripts, routing rules, daily/weekly limits.
- Operates the kill switch via the singleton Pipeline Control issue.
- Acts as fallback for any unfilled domain-owner role.

There is exactly one Primary Maintainer at a time. If that role transitions, the Current Contributors section is updated in the same PR that transfers ownership.

### Domain Owner

A human who owns a defined slice of the project (an app-feature area, an infrastructure layer, a spec extension). Domain owners come and go — the role exists whether or not someone is currently filling it.

- Domain-reviews PRs touching their slice.
- Veto-capable on changes to their slice.
- Surfaces domain-specific spec questions back to the Primary Maintainer.
- May implement directly in their slice or delegate to agents under task contracts.

When no human currently owns a domain, the Primary Maintainer covers it. The pipeline does not block on absent domain owners — it falls back.

### Spec Co-Author

A human authorised to edit specific normative `wot-spec/` paths under the synchronous-supervision rule (Hard Rule 1). Limited to specific extension areas (e.g. HMC).

The Primary Maintainer remains the merge gate even for paths a co-author edits.

### Claude — spec, architecture, crypto agent

Reviewer roles served: `spec`, `architecture`, `integration`, plus crypto-specific `security`.

- Spec compliance reviews (knows the `wot-spec/` repository and its test vectors).
- Architecture reviews (knows `../wot-spec/IMPLEMENTATION-ARCHITECTURE.md` and layer rules).
- Crypto-specific security: ECIES, Ed25519/X25519, JWS, key derivation.
- Cross-cutting implementations: refactors, layer migrations, multi-package work.
- Drafts non-normative research documents in `wot-spec/research/` via task contract; human approval required before merge.
- Integration role: synthesises reviewer outputs into the canonical four-value verdict (`mergeable | blocked | needs human decision | needs more review`) defined in `pr-review-rubric.md`.

### Codex — focused implementation agent

Reviewer role served: `tests`.

- Focused implementations of individual spec sections against test vectors.
- Test scaffolding from JSON test vectors to vitest.
- Adapter implementations against existing ports.
- Bug fixes for conformance regressions (well-scoped by a failing test).
- Test reviews: coverage, edge cases, missing regression tests.

### CodeRabbit — 24/7 baseline reviewer

Reviewer roles served: `security` (baseline), code-quality.

- Generic security baseline: SAST patterns, OWASP, dependency scans.
- Anti-patterns, readability, common bug shapes.
- Style and maintainability — no spec context, but consistent code standards.
- Runs on the GitHub side, independent of any laptop being online.
- First line of defence before deeper reviews from Claude or Codex.

## Pipeline Phases

| Phase | Primary Maintainer | Domain Owner | Claude | Codex | CodeRabbit |
| --- | --- | --- | --- | --- | --- |
| Spec authoring (`wot-spec/`) | **Lead** | Co-author for own area (synchronous) | Synchronous co-author | — | — |
| Conformance watcher | Sees red issues | Owns infra slice if filled | Operates script | — | — |
| Gap analysis | Reviews weekly | Supplies domain metrics if filled | **Generates** | — | — |
| Task generation | Approves `ready` | Approves changes in own scope | **Generates** | — | — |
| Routing | Sets rules | — | (Self-pick) | (Self-pick) | — |
| Implementation | Anything not delegated | Within own scope | Refactors / arch | **Spec sections + tests** | — |
| Review `spec` | Override right | Domain-specific | **Lead** | — | — |
| Review `architecture` | Override right | — | **Lead** | — | — |
| Review `tests` | — | — | — | **Lead** | Secondary |
| Review `security` baseline | — | — | Crypto specifics | — | **Lead** |
| Review `security` crypto | Override right | — | **Lead** | — | — |
| Review `integration` (synthesis) | — | — | **Lead** | — | — |
| Merge | **Final** | — | — | — | — |
| State of Project (Sundays) | Reads | Maintains if infra owner filled | Generates draft | — | — |

When a Domain Owner role is unfilled, the Primary Maintainer covers it.

## Three Hard Rules

1. **Bounded Autonomy on normative spec.** Normative spec changes require synchronous human supervision.

   Normative paths in `wot-spec/` — `01-wot-identity/`, `02-wot-trust/`, `03-wot-sync/`, `04-rls-extensions/`, `05-hmc-extensions/`, `schemas/`, `test-vectors/`, `conformance/`, `ROADMAP.md`, `CONFORMANCE.md`, `VERSIONING.md`, `CHANGELOG.md` — may be edited with AI assistance during a real-time session, where the Primary Maintainer (or an explicitly-approved Spec Co-Author for a defined area) reviews each diff before commit. The Web of Trust spec was authored this way and continues to evolve this way.

   **Autonomous task contracts MUST NOT include normative paths in `allowed_scope`.** Agents running outside a synchronous session may propose changes only via Issues with label `spec-gap`. The bright line is the mode of work, not the keyboard: synchronous co-authoring is allowed; nightly or hands-off task execution against normative paths is not.

   Non-normative paths in `wot-spec/research/` may be drafted by agents under an explicit task contract; the merge still requires the Primary Maintainer's approval.

2. **Merge is the Primary Maintainer.** Even with three reviewer agents approved, the final click stays with the human in the Primary Maintainer role.

3. **Domain sovereignty (when filled).** Changes inside a domain need that domain's owner approval, if a domain owner is currently active. Owners are veto-capable in their slice. Unfilled domains fall back to the Primary Maintainer — the pipeline never blocks on an absent owner.

## Escalation

When a PR or task triggers any of these, automation stops and a human decides:

- Normative protocol behavior change.
- Cryptographic primitives, key derivation, signature semantics.
- Persistent data migration or backward-compatibility break.
- Public API breaking change.
- Production deployment or release.
- Conflicting changes from another agent or person.
- Spec ambiguity that can't be resolved from existing documents.

Escalation marker: PR or issue gets the label `needs-human` or `needs-discussion`. The relevant human is pinged based on domain — the Primary Maintainer for spec/architecture/crypto/anything-unfilled, the Domain Owner for their specific slice.

## Avoiding Approval Fatigue

The pipeline can produce more PRs than a human can read carefully. When that happens, oversight degrades into rubber-stamping — the human clicks merge without real review, the Generator-Evaluator pattern collapses into theatre. This is **approval fatigue** and it is the single largest failure mode of automation like this.

The mitigations baked into this pipeline:

- **Daily caps.** `local-pipeline.md` defines hard limits on tasks per day. Conservative defaults until trust is calibrated.
- **Three reviewer roles before human.** The integrator verdict synthesises spec, architecture, tests, and security findings. The human reads one summary, not four streams.
- **State-of-Project dashboard.** The Sunday read is the human's structural oversight surface — sample reviews, trend lines, drift indicators — instead of every PR.
- **Sampling, not exhaustive review.** The Primary Maintainer is expected to review one randomly-selected PR per day in depth, plus all `needs-discussion` and `blocked` items. Not all PRs.
- **Pause without guilt.** The kill switch is a one-click action. If review backlog exceeds capacity, pause the implementation runner until backlog drains.

If the maintainer ever feels they are merging without reading: that is the signal to pause. The pipeline failing slow is preferable to silent rubber-stamping.

## Current Contributors

This section is the live snapshot. It changes as people and scopes change. Update this in any PR that shifts who fills which role.

*As of 2026-05-02:*

- **Primary Maintainer:** Anton (full-time)
- **Domain Owners:** None currently formalised. Anton covers all domains by default. Other humans contribute in phases without locked-in scope:
  - Tillmann Heigel — interest in metrics, logging, integration tests, infrastructure. Phase-based contribution; no formal domain ownership yet.
  - Sebastian Stein — currently building app features (comments and reactions). Phase-based contribution; no formal domain ownership yet.
- **Spec Co-Authors:** Sebastian Schürmann is approved for HMC extension paths (`05-hmc-extensions/H01-H03`).
- **Eli:** Intentionally not in the pipeline. Eli holds memory and serves as conversation partner; Eli is not a code worker.

## Open Questions

- **Domain-Owner formalisation.** When does a phase-based contributor's scope become a formal Domain Owner role? Trigger could be: same person reviews 5+ PRs in the same area, or accepts an explicit ownership offer. Until then they remain phase-based contributors and the Primary Maintainer covers their area.
- **Pipeline ownership location.** Scripts and systemd units live on the Primary Maintainer's laptop. If the project gains a dedicated Infra Domain Owner, ownership of orchestrator scripts could shift there. Either way, the orchestrator config stays human-readable and version-controlled.
- **Auto-routing to Domain Owners.** Currently any domain owner ping is manual. Future: PRs touching paths owned by a known Domain Owner get an auto-label and block on their comment. Requires formalised path-to-owner mapping — deferred until at least one Domain Owner role is filled.
