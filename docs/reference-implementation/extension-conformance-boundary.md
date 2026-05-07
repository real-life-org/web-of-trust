# Reference Extension Conformance Boundary: `wot-rls@0.1` and `wot-hmc@0.1`

**Status:** Documentation-only boundary map. This document is non-normative.
**Last updated:** 2026-05-07.
**Scope:** Maps the current TypeScript reference implementation boundary for the extension profiles listed in `../wot-spec/CONFORMANCE.md#wot-rls01`, `../wot-spec/CONFORMANCE.md#wot-hmc01`, and `../wot-spec/conformance/manifest.json`.

This slice does not claim full `wot-rls@0.1` or `wot-hmc@0.1` conformance. It records what is vector-backed today, what can be safely ignored by this repository, what must remain non-implemented because the owning document is placeholder/non-normative, and what is blocked pending `wot-spec` clarification.

No runtime behavior changes are introduced by this document.

## Source Traceability

Profile | Spec refs | Schemas | Vectors / implementation evidence
---|---|---|---
`wot-rls@0.1` | `../wot-spec/04-rls-extensions/R01-badges.md` | none | none
`wot-hmc@0.1` | `../wot-spec/05-hmc-extensions/H01-trust-scores.md`, `../wot-spec/05-hmc-extensions/H02-transactions.md`, `../wot-spec/05-hmc-extensions/H03-gossip.md` | `../wot-spec/schemas/trust-list-delta.schema.json` | `../wot-spec/test-vectors/phase-1-interop.json#sd_jwt_vc_trust_list`; `packages/wot-core/src/protocol/trust/sd-jwt-vc.ts`

Open `wot-spec` issues referenced by this boundary:

- [`wot-spec#9`](https://github.com/real-life-org/wot-spec/issues/9): HMC trust-score computation remains underspecified for a TypeScript reference implementation.
- [`wot-spec#43`](https://github.com/real-life-org/wot-spec/issues/43): trust-list-delta authority and forwarding semantics remain open.
- [`wot-spec#44`](https://github.com/real-life-org/wot-spec/issues/44): trust-list-delta / SD-JWT disclosure regex questions remain open.
- [`wot-spec#46`](https://github.com/real-life-org/wot-spec/issues/46): profile-level ambiguity between `CONFORMANCE.md` / manifest entries and placeholder extension documents.

## Disposition Legend

- **Implemented/vector-backed:** current TypeScript protocol code reproduces or verifies a listed `wot-spec` vector. This is not a full profile claim.
- **Safe-ignore only:** the reference implementation may accept or pass over extension data/messages as unknown optional material, but does not generate or interpret the extension semantics.
- **Placeholder/non-normative:** the referenced extension text is not implementation authority for this repo. Generation, validation, payment, or domain behavior must not be implemented from it.
- **Blocked pending `wot-spec` clarification:** behavior may affect interop or security and must not be invented locally.

## Extension Document Map

Document | Profile | Classification | Current TypeScript boundary | Follow-up candidate
---|---|---|---|---
`04-rls-extensions/R01-badges.md` | `wot-rls@0.1` | **Placeholder/non-normative** | No RLS-specific generation, validation, badge rendering rules, event rules, or place rules are implemented. Unknown RLS extension fields may only be treated under the general safe-ignore rule for optional fields. | Wait for `wot-spec#46` to clarify whether placeholder extension documents are claimable conformance inputs before creating any RLS runner task.
`05-hmc-extensions/H01-trust-scores.md` | `wot-hmc@0.1` | **Implemented/vector-backed** | `packages/wot-core/src/protocol/trust/sd-jwt-vc.ts` covers only the `sd_jwt_vc_trust_list` vector mechanics: disclosure encoding, disclosure digest, compact construction, issuer JWS verification, and digest presence. It does not compute trust scores, rank users, evaluate liability, enforce hop limits, or consume a graph. Trust-score computation is **blocked pending `wot-spec` clarification** in `wot-spec#9`. | After `wot-spec#9`, add a dedicated trust-score computation slice with vectors and tests. Until then, keep the current SD-JWT VC helper documented as vector-level coverage only.
`05-hmc-extensions/H02-transactions.md` | `wot-hmc@0.1` | **Placeholder/non-normative** | No HMC transaction, payment, settlement, invoice, balance, or money-movement behavior is implemented. This repo must not implement transaction/payment behavior from H02 while it remains placeholder/non-normative. | Wait for normative H02 text and human-approved spec changes before any runner task touches payment or transaction behavior.
`05-hmc-extensions/H03-gossip.md` | `wot-hmc@0.1` | **Blocked pending `wot-spec` clarification** with a narrow schema-backed envelope surface | The plaintext-envelope shape and `body.delta` schema surface can be handled by a separate narrow parser slice when it stays aligned with `schemas/trust-list-delta.schema.json`. That does not implement HMC gossip conformance: forwarding, hop-limit handling, sent-log retention, piggyback dispatch, storage, replay/deduplication, and authority decisions remain unimplemented. Unknown HMC gossip messages remain safely ignored unless a merged parser slice handles the exact schema-backed `trust-list-delta` shape. `trust-list-delta` authority/forwarding and disclosure regex questions are tracked in `wot-spec#43` and `wot-spec#44`. | Keep schema-backed envelope parsing separate from HMC gossip dispatch. Add forwarding/storage behavior only after `wot-spec#43` resolves the authority boundary and after the disclosure regex decision in `wot-spec#44` is reflected in schema/tests.

## Profile-Level Boundary

`../wot-spec/conformance/manifest.json` lists `wot-rls@0.1` and `wot-hmc@0.1` as profiles, but the referenced extension documents include placeholder/non-normative material. This repo must not decide whether those placeholder documents are enough to claim profile conformance. That ambiguity is tracked by `wot-spec#46`.

Current claimable implementation evidence is narrower:

- `wot-rls@0.1`: no implemented or vector-backed RLS extension behavior in this repo.
- `wot-hmc@0.1`: vector-level SD-JWT VC trust-list mechanics only, via `phase-1-interop.json#sd_jwt_vc_trust_list` and `packages/wot-core/src/protocol/trust/sd-jwt-vc.ts`.

Therefore, future PRs must avoid wording such as "full `wot-rls@0.1` conformance" or "full `wot-hmc@0.1` conformance" unless the relevant spec issues are resolved and new behavior is covered by tests or vectors.

## Non-Implementation Rules

- RLS-specific generation and validation behavior must not be implemented from `R01-badges.md` while it is marked placeholder/non-normative.
- HMC transaction/payment behavior must not be implemented from `H02-transactions.md` while it is marked placeholder/non-normative.
- HMC trust-score computation must remain blocked until `wot-spec#9` resolves the algorithm and interop expectations.
- Trust-list-delta authority, forwarding, hop-limit handling, sent-log retention, piggyback dispatch, storage, replay/deduplication, and disclosure regex behavior must remain blocked until `wot-spec#43` and `wot-spec#44` resolve the normative boundary.
- Placeholder extension documents must not be promoted to conformance claims in this repo while `wot-spec#46` is open.

## Runner Task Candidates

Candidate | Prerequisite | Allowed implementation surface
---|---|---
RLS extension-field tolerance audit | `wot-spec#46` or explicit RLS normative text | Documentation or protocol tests proving unknown RLS fields are safely ignored by existing Trust VC handling. No badge generation/validation.
HMC SD-JWT VC hardening | Additional vectors for invalid disclosure/digest cases | `packages/wot-core/src/protocol/trust/sd-jwt-vc.ts` and focused protocol tests only. Still no score computation claim.
HMC trust-score computation | `wot-spec#9` resolved with deterministic vectors | New protocol/application module and tests, scoped to the resolved algorithm.
HMC trust-list-delta envelope parsing | Schema-backed envelope/body shape accepted as an isolated boundary; any regex decision from `wot-spec#44` reflected in schema/tests | Parser and verifier boundaries only. No forwarding, hop-limit, sent-log, piggyback, replay, storage, or authority semantics.
HMC gossip dispatch | Normative H03 message semantics and vectors | Message parsing/dispatch behavior only after required ignore, forward, and persistence semantics are explicit.

## Out of Scope

This slice does not change:

- Runtime code, package exports, application workflows, adapters, demo code, schemas, tests, or spec files.
- `docs/reference-implementation/demo-consumer-map.md`, `docs/reference-implementation/legacy-boundary-map.md`, or `docs/reference-implementation/wot-identity-conformance.md`.
- The canonical `wot-spec` repository.
