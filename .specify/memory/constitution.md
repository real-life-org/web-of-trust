# Web-of-Trust Implementation Constitution

## Core Principles

### I. Normative Spec Authority

`wot-spec` is the normative source for protocol behavior, schemas, and test vectors. Spec Kit artifacts in this repository describe implementation work only and MUST trace every protocol requirement to a `wot-spec` document, schema, or vector. Implementation tasks MUST NOT modify `wot-spec` or reinterpret normative language without an explicit human gate.

### II. Small Conformance Slices

Each feature MUST be scoped to an independently testable conformance slice, such as one protocol message, schema, test-vector section, or profile gap. The allowed and forbidden file scopes MUST be explicit before an agent or human starts implementation. Larger workflows must be decomposed into slices before implementation.

### III. Test-First TypeScript Reference

Implementation changes MUST include automated checks that prove the slice against the referenced spec material. Behavior-changing TypeScript slices MUST be test-driven by default: write or update the smallest meaningful test first, verify the expected failure when feasible, implement the smallest production change, and then run the task checks. For `@web_of_trust/core`, protocol changes require targeted Vitest coverage, `typecheck`, and `build`. When core output consumed by `packages/wot-vault/wot-core-dist` changes, the vendored Vault distribution MUST be refreshed with the repository refresh script before the slice is considered complete.

### IV. Conformance and Legacy Ledgers

Every slice that changes spec coverage MUST update `docs/conformance/ts-implementation-map.md` or explicitly state why the map is unchanged. Every slice that touches, replaces, preserves, or removes legacy implementation paths MUST update `docs/architecture/legacy-retirement.md` or explicitly state why the map is unchanged. Agents MUST NOT deepen dependencies on contained or superseded legacy surfaces without a human gate.

### V. Security and Crypto Human Gates

Changes affecting key material, signatures, DID/JWS semantics, encryption, authorization, membership removal, storage confidentiality, external service activation, or breaking API behavior require human approval before merge. Agents may propose or draft such changes, but the state must stop at a human-decision gate.

### VI. Human-Controlled Delivery

Agents may implement, run checks, open PRs, and review under explicit scope, but MUST NOT merge, release, force-push, bypass hooks, or run untrusted PR content with broad shell access. Visible state belongs in Spec Kit artifacts, GitHub PRs/issues/labels, and runner state files, not in hidden local memory.

## Repository Constraints

The implementation repository is a pnpm/Turbo TypeScript monorepo targeting Node.js 20 or newer. Primary implementation code lives under `packages/`, demo applications under `apps/`, and automation under `scripts/` and `.github/`. Feature specs must name exact package paths and commands rather than relying on generic project assumptions.

Normative references should point to paths in `/home/fritz/workspace/workspace/wot-spec` during local experiments and to repository-relative paths or links in PR descriptions. Generated or vendored artifacts are allowed only when the existing repository workflow requires them.

## Development Workflow

Spec Kit workflow for implementation slices is: constitution check, feature spec, implementation plan, tasks, tests-first implementation, checks, independent review, human gate. Claude Code CLI and Codex CLI can be used as local implementer/reviewer workers when explicitly invoked by a runner. Default runner behavior must be dry-run and read-only unless execution flags are provided.

Each plan MUST state the constitution check result before implementation. Each task list MUST include exact acceptance checks, TDD/red-green expectations, conformance-map impact, legacy-map impact, and a no-auto-merge gate. Any ambiguity between Spec Kit artifacts and `wot-spec` resolves in favor of `wot-spec` and should stop work for human clarification if it changes behavior.

## Governance

This constitution governs Spec Kit usage for `web-of-trust` implementation work. Amendments require a human-reviewed change explaining the reason, migration impact, and affected automation behavior. Existing shipped behavior may require backward compatibility only when persisted data, external consumers, or explicit user requirements make it concrete.

## Amendment Record

- 0.2.0-experiment: Add test-first delivery, conformance tracking, and legacy retirement ledgers so long-horizon agent work remains auditable across small PR slices.

**Version**: 0.2.0-experiment | **Ratified**: Pending human approval | **Last Amended**: 2026-05-05
