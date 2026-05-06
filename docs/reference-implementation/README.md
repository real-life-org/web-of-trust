# Reference Implementation Program

> **Status:** Draft inventory. This document is non-normative. The normative protocol source is the [`wot-spec`](https://github.com/real-life-org/wot-spec) repository. When this document and the spec disagree, the spec wins.
>
> **Local checkout:** Contributors who work on both repositories typically check `wot-spec` out as a sibling of this repo (i.e. `../wot-spec/` relative to this worktree). Path references to spec files in this document use that sibling layout for local navigation; on GitHub, follow the canonical links to the public spec repo above.

## Purpose

This directory is the human-readable executive map for the Web-of-Trust **reference implementation** in TypeScript. It explains:

- What the reference implementation is and what it is not.
- Which layers it has and how each layer maps to a `wot-spec` profile.
- How future PRs trace their changes back to the spec, conformance, tests, and open questions.

The reference implementation is the codebase under [`packages/wot-core`](../../packages/wot-core/), the CRDT adapters in [`packages/adapter-yjs`](../../packages/adapter-yjs/) and [`packages/adapter-automerge`](../../packages/adapter-automerge/), the server packages in [`packages/wot-relay`](../../packages/wot-relay/), [`packages/wot-profiles`](../../packages/wot-profiles/), [`packages/wot-vault`](../../packages/wot-vault/), and the demo app under [`apps/demo`](../../apps/demo/).

## Authority Model

The reference implementation **replaces** the legacy implementation authority by default. It does not extend it.

Concretely:

- Protocol semantics (DID, JWS/JCS, attestations, sync log entries, capabilities, group keys) are derived from `wot-spec` documents and validated against `wot-spec/test-vectors/` and `wot-spec/conformance/`.
- Where the legacy code in `packages/wot-core/src/services/`, `packages/wot-core/src/identity/WotIdentity.ts`, and the demo's app-local adapters disagrees with the spec, the spec wins and the legacy path is migrated or removed.
- Legacy APIs and compatibility shims are not preserved unless they are listed as a conscious decision in the relevant slice plan.
- "Deviations from Specification" recorded in [`docs/CURRENT_IMPLEMENTATION.md`](../CURRENT_IMPLEMENTATION.md) are described as legacy state, not as the target. Each deviation that survives must either be lifted to a spec change, normalised away in the implementation, or recorded as a conscious decision in this folder.

This means the reference implementation program is a **program of replacement**: every slice we land moves authority away from legacy services and onto spec-aligned modules in `protocol`, `application`, `ports`, and `adapters`.

## Target Layers

The TypeScript surface follows a strict layered architecture. The pictured arrows are the only allowed direction of imports.

```text
app -> react -> application -> protocol
                         \--> ports
adapters -> ports
adapters -> protocol (only for wire/payload types)
app -> adapters         (composition root only — see note below)
app -> protocol         (composition root only, for wire/payload types)
```

The `app -> adapters` and `app -> protocol` arrows are only allowed at the composition root. Application use cases, the React layer, and other library code MUST NOT import concrete adapters directly — they go through `ports`.

Layer | Where it lives | Purpose | Imports allowed
---|---|---|---
`protocol` | `packages/wot-core/src/protocol/` | Deterministic spec rules: encoding, JCS, JWS, DID, attestation VC-JWS, sync log entries, capabilities, ECIES, personal-doc helpers. Reproduces `wot-spec` test vectors. | Pure types and small crypto ports only. No storage, no transport, no React, no CRDT, no UI.
`application` | `packages/wot-core/src/application/` (and parts of `packages/wot-core/src/services/` that still need to be classified) | Framework-free use cases: identity lifecycle, verification flow, attestation flow, spaces orchestration, sync workflows. | `protocol`, `ports`, plain domain types.
`ports` | `packages/wot-core/src/ports/` | Narrow capability interfaces: `IdentitySeedVault`, `StorageAdapter`, `MessagingAdapter`, `DiscoveryAdapter`, `ReplicationAdapter`, `CryptoAdapter`, `OutboxStore`, `SeedStorageAdapter`, `SpaceMetadataStorage`, `Subscribable`, etc. | Only types from `protocol` or domain types.
`adapters` | `packages/wot-core/src/adapters/`, `packages/wot-core/src/protocol-adapters/`, `packages/adapter-yjs/`, `packages/adapter-automerge/` | Concrete platform implementations: Web Crypto, IndexedDB, WebSocket relay, HTTP profile/vault, Yjs/Automerge document stores. | `ports`, `protocol` for wire shapes, platform APIs. Must not import application use cases as a hard dependency.
`react` | `apps/demo/src/hooks/` and `apps/demo/src/context/` today; possibly `packages/wot-react/` later | Hooks and providers that expose application use cases to the UI. | `application` use cases, view-model types.
`app` | `apps/demo/`, `apps/landing/`, `apps/benchmark/`, `packages/wot-cli/`, server bins | Composition root, runtime wiring, routes, product UI, deployment-specific glue. | Anything, but only at the composition root.

The composition root for the demo is [`apps/demo/src/runtime/appRuntime.ts`](../../apps/demo/src/runtime/appRuntime.ts). It imports concrete adapters (`WebCryptoProtocolCryptoAdapter`, `SeedStorageIdentityVault`, `HttpDiscoveryAdapter`) and wires them into application workflows (`IdentityWorkflow`, `VerificationWorkflow`, `AttestationWorkflow`).

## Mapping to `wot-spec` Profiles

The conformance profiles defined in [`wot-spec/CONFORMANCE.md`](https://github.com/real-life-org/wot-spec/blob/main/CONFORMANCE.md) and [`wot-spec/conformance/manifest.json`](https://github.com/real-life-org/wot-spec/blob/main/conformance/manifest.json) are the contract a reference implementation slice must satisfy.

`wot-spec` profile | Spec entry points | Reference implementation modules
---|---|---
`wot-identity@0.1` | `wot-spec/01-wot-identity/`, `wot-spec/test-vectors/phase-1-interop.json` | `packages/wot-core/src/protocol/identity/`, `packages/wot-core/src/protocol/crypto/`, `packages/wot-core/src/protocol-adapters/web-crypto.ts`, `packages/wot-core/src/application/identity/`, `packages/wot-core/src/ports/identity-vault.ts`, `packages/wot-core/src/ports/SeedStorageAdapter.ts`
`wot-trust@0.1` | `wot-spec/02-wot-trust/` | `packages/wot-core/src/protocol/trust/`, `packages/wot-core/src/application/attestations/`, `packages/wot-core/src/application/verification/`
`wot-sync@0.1` | `wot-spec/03-wot-sync/` (notably `002-sync-protokoll.md`, `003-transport-und-broker.md`, `005-gruppen.md`, `006-personal-doc.md`) | `packages/wot-core/src/protocol/sync/`, `packages/wot-core/src/application/spaces/`, parts of `packages/wot-core/src/services/` (`EncryptedSyncService`, `GroupKeyService`, `VaultClient`, `VaultPushScheduler`), `packages/wot-core/src/ports/spaces.ts`, `packages/wot-core/src/ports/MessagingAdapter.ts`, `packages/wot-core/src/ports/ReplicationAdapter.ts`, `packages/adapter-yjs/`, `packages/adapter-automerge/`, `packages/wot-relay/`, `packages/wot-vault/`, `packages/wot-profiles/`
`wot-device-delegation@0.1` (planned, Phase 2) | `wot-spec/01-wot-identity/004-device-key-delegation.md`, `wot-spec/test-vectors/device-delegation.json` | `packages/wot-core/src/protocol/identity/device-key-binding.ts`, future `packages/wot-core/src/application/devices/`
`wot-rls@0.1` | `wot-spec/04-rls-extensions/` | Extension code outside core; not yet implemented in this repo.
`wot-hmc@0.1` | `wot-spec/05-hmc-extensions/` | `packages/wot-core/src/protocol/trust/sd-jwt-vc.ts`; the rest is upstream of this repo.

Coverage status for individual vectors lives in [`packages/wot-core/src/protocol/COVERAGE.md`](../../packages/wot-core/src/protocol/COVERAGE.md).

## Slice Plan

Vertical slices are tracked in [`docs/reference-implementation-refactor.md`](../reference-implementation-refactor.md). At the time of this inventory the slices are:

1. Protocol rename — done.
2. Identity — landed for the new demo flow; legacy `WotIdentity` still present for legacy callers.
3. Verification — landed; legacy facade removed.
4. Attestations — landed; new attestations carry a VC-JWS.
5. Device Keys — open.
6. Spaces and Sync — first application workflow landed (`SpacesWorkflow`); CRDT adapters still own document-level sync details.

This README is the executive map. The slice plan is the detail plan. The two should stay consistent: when a slice merges, update both.

## Traceability Rules for Future PRs

Every PR that changes reference implementation behavior MUST include a traceability block in the PR description (or the cover commit) with the following five items. These rules apply to behavior-changing slices, not to documentation-only inventory updates like this one.

1. **Spec refs.** Cite the `wot-spec` documents the slice implements. Use stable section anchors. Example: `wot-spec/03-wot-sync/005-gruppen.md#member-update`.
2. **Conformance profile.** Name the profile or profiles affected (e.g. `wot-sync@0.1`). If the slice introduces a new requirement, point at the profile section in [`wot-spec/CONFORMANCE.md`](https://github.com/real-life-org/wot-spec/blob/main/CONFORMANCE.md) and at the manifest entry in [`wot-spec/conformance/manifest.json`](https://github.com/real-life-org/wot-spec/blob/main/conformance/manifest.json).
3. **Implementation module.** Name the package and layer. Example: `packages/wot-core/src/application/spaces/SpacesWorkflow.ts (application)` or `packages/adapter-yjs/src/YjsReplicationAdapter.ts (adapter)`. State the layer explicitly so reviewers can enforce the import rules above.
4. **Tests / vectors.** Cite the unit, contract, or vector tests that exercise the change. For protocol-level changes, cite the `wot-spec` test vector that the implementation reproduces. For application changes, cite the use-case test. For adapter changes, cite the contract test.
5. **Open spec questions.** If the slice surfaced ambiguity in the spec, list the question here and link to the issue, discussion, or follow-up PR in `wot-spec`. Do not invent implementation behavior to silence the ambiguity. Document the question and either (a) defer the slice, or (b) implement against the most conservative reading and record the open question.

PRs that touch only `docs/reference-implementation/` may use a shortened block (spec refs and open questions) since they do not change runtime behavior.

## Open Questions Surfaced by This Inventory

Captured for follow-up. None of these are decided here.

- Port surface area is still in flux. All capability interfaces currently live in `packages/wot-core/src/ports/`, but several of them (`StorageAdapter`, `MessagingAdapter`, `DiscoveryAdapter`, `ReplicationAdapter`, `CryptoAdapter`, `OutboxStore`, etc.) are named after adapters and shaped against today's concrete implementations rather than against the spec contracts described in [`IMPLEMENTATION-ARCHITECTURE.md`](https://github.com/real-life-org/wot-spec/blob/main/IMPLEMENTATION-ARCHITECTURE.md). A separate slice should re-shape them around spec roles.
- `packages/wot-core/src/services/` mixes application use cases and infrastructure. Each service needs to be classified before it can be cleanly moved to `application` or `adapters`.
- Browser-only adapters (HTTP, WebSocket, IndexedDB, LocalStorage) are still exported from the core root. They should move behind explicit adapter entry points.
- The `react` layer is not yet a package. The hooks live in `apps/demo/src/hooks/`. Extraction should wait for a second consumer.
- Coverage of `wot-sync@0.1` is incomplete: `member-update` semantics, the known-device `device-revoke` broker disposition helper, key-rotation generation handling, and snapshot/full-state usage are tracked in slices against `wot-spec/03-wot-sync/`. The device revocation helper is protocol-only post-signature guidance for a caller-supplied exact broker device record; unknown-device tombstones, inactive/TTL cleanup, malformed `deviceId` validation, error mapping, and real broker persistence remain deferred to `wot-spec` issues #27, #28, and #32. The local `docs/spec/sync-protocol.md` is implementation-side working notes, not a spec entry point.

## Scope of This Slice

This slice is **documentation only**.

- No package exports change.
- No runtime code changes.
- No legacy compatibility shims are introduced or removed by this slice.
- No tests are added or removed. Future slices add the tests their behavior requires.

If a follow-up reading uncovers a normative gap, raise it as a `wot-spec` PR before changing TypeScript behavior.
