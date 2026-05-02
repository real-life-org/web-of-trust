# Pipeline Responsibilities

Status: operational, non-normative.

This document assigns roles in the project-flow pipeline to humans and agents. It is the contract between team members and the automation. When in doubt about who decides or who acts, this document is the reference.

## People and Agents

### Anton — spec owner and final gate

- Authors normative documents in `wot-spec/`. Not delegable to agents.
- Owns architecture decisions: `IMPLEMENTATION-ARCHITECTURE.md`, layer boundaries, SDK boundaries.
- Holds the merge-gate: every PR merge is a human click.
- Resolves conflicts when agent reviewers disagree (`needs-discussion` label).
- Owns the pipeline configuration: scripts, routing rules, daily/weekly limits.
- Operates the kill switch via the `paused-by-human` label.

### Sebastian Stein — co-implementer and domain reviewer

- Implements features in the WoT app (currently: comments and reactions).
- Domain-reviews PRs touching app-feature code paths he owns.
- Surfaces UX-driven spec questions back to Anton when implementation hits ambiguity.
- Performance and load testing alongside Anton.

### Tillmann — infrastructure, metrics, integration tests

- Owns the metrics pipeline: throughput, spec coverage, regression rate.
- Owns structured logging across the system.
- Owns end-to-end integration tests, multi-device scenarios.
- Maintains the State-of-Project dashboard generator.
- Hardens CI/CD: GitHub Actions, Watchtower, deploy pipeline.

### Claude — spec, architecture, crypto agent

Reviewer roles served: `spec`, `architecture`, `integration`, plus crypto-specific `security`.

- Spec compliance reviews (knows `wot-spec/` and test vectors).
- Architecture reviews (knows `IMPLEMENTATION-ARCHITECTURE.md` and layer rules).
- Crypto-specific security: ECIES, Ed25519/X25519, JWS, key derivation.
- Cross-cutting implementations: refactors, layer migrations, multi-package work.
- Drafts non-normative research documents in `wot-spec/research/` via task contract; human approval required before merge.
- Integration role: synthesises reviewer outputs into a `mergeable | blocked | needs human decision` verdict.

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

| Phase | Anton | Sebastian Stein | Tillmann | Claude | Codex | CodeRabbit |
| --- | --- | --- | --- | --- | --- | --- |
| Spec authoring (`wot-spec/`) | **Lead** | — | Test requirements | Proposal/research | — | — |
| Conformance watcher | Sees red issues | — | Owns tests + logs | Operates script | — | — |
| Gap analysis | Reviews weekly | — | Supplies metrics | **Generates** | — | — |
| Task generation | Approves `ready` | Approves app scope | — | **Generates** | — | — |
| Routing | Sets rules | — | — | (Self-pick) | (Self-pick) | — |
| Implementation | — | App features | — | Refactors / arch | **Spec sections + tests** | — |
| Review `spec` | Override right | App-domain | — | **Lead** | — | — |
| Review `architecture` | Override right | — | — | **Lead** | — | — |
| Review `tests` | — | — | — | — | **Lead** | Secondary |
| Review `security` baseline | — | — | — | Crypto specifics | — | **Lead** |
| Review `security` crypto | Override right | — | — | **Lead** | — | — |
| Review `integration` (synthesis) | — | — | — | **Lead** | — | — |
| Merge | **Final** | — | — | — | — | — |
| State of Project (Sundays) | Reads | Reads | **Maintains** | Generates draft | — | — |

## Three Hard Rules

1. **Normative spec changes require synchronous human supervision.**

   Normative paths in `wot-spec/` — `01-wot-identity/`, `02-wot-trust/`, `03-wot-sync/`, `04-rls-extensions/`, `05-hmc-extensions/`, `schemas/`, `test-vectors/`, `conformance/`, `ROADMAP.md`, `CONFORMANCE.md`, `VERSIONING.md`, `CHANGELOG.md` — may be edited with AI assistance during a real-time session, where Anton (or an explicitly-approved co-author such as Sebastian Schürmann for HMC) reviews each diff before commit. The Web of Trust spec was authored this way and continues to evolve this way.

   **Autonomous task contracts MUST NOT include normative paths in `allowed_scope`.** Agents running outside a synchronous session may propose changes only via Issues with label `spec-gap`. The bright line is the mode of work, not the keyboard: synchronous co-authoring is allowed; nightly or hands-off task execution against normative paths is not.

   Non-normative paths in `wot-spec/research/` may be drafted by agents under an explicit task contract; the merge still requires Anton's approval.

2. **Merge is Anton.** Even with three reviewer agents approved, the final click stays human.

3. **Domain sovereignty.** App-feature changes need Sebastian Stein's approval if they touch his active scope. Infrastructure changes need Tillmann's approval. Both are veto-capable in their domains.

## Escalation

When a PR or task triggers any of these, automation stops and a human decides:

- Normative protocol behavior change.
- Cryptographic primitives, key derivation, signature semantics.
- Persistent data migration or backward-compatibility break.
- Public API breaking change.
- Production deployment or release.
- Conflicting changes from another agent or person.
- Spec ambiguity that can't be resolved from existing documents.

Escalation marker: PR or issue gets the label `needs-human` or `needs-discussion`. The relevant human is pinged based on domain (Anton for spec/architecture/crypto, Sebastian Stein for app features, Tillmann for infrastructure).

## Open Questions

- **Pipeline ownership location.** Scripts and systemd units live on Anton's laptop initially. When Tillmann's infrastructure work matures, ownership of the orchestrator scripts may move to him as the Infra owner. Either way, the orchestrator config stays human-readable and version-controlled.
- **Sebastian Stein cross-review trigger.** Currently a manual ping. Future: PRs touching app-feature code paths get auto-label `needs-sebastian` and block on his comment. Decision pending until app-feature path boundaries are formalised.
- **Eli's role.** Eli is intentionally not in the pipeline. Eli holds memory and serves as conversation partner; Eli is not a code worker.
