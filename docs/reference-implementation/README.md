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
- Where the legacy code in `packages/wot-core/src/services/`, `packages/wot-core/src/crypto/`, and the demo's app-local adapters disagrees with the spec, the spec wins and the legacy path is migrated or removed. (The previous `packages/wot-core/src/identity/WotIdentity.ts` legacy directory has already been removed; identity flows live in `application/identity/`.)
- Legacy APIs and compatibility shims are not preserved unless they are listed as a conscious decision in the relevant slice plan.
- "Deviations from Specification" recorded in [`docs/CURRENT_IMPLEMENTATION.md`](../CURRENT_IMPLEMENTATION.md) are described as legacy state, not as the target. Each deviation that survives must either be lifted to a spec change, normalized away in the implementation, or recorded as a conscious decision in this folder.

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
`application` | `packages/wot-core/src/application/`. Phase 1 löscht `packages/wot-core/src/services/*` und verteilt die Funktionalität als spec-zuerst neu geschriebene Workflows in `application/sync/`, `application/discovery/`, `application/verification/` etc. (Slices `1.B.3-*` und `1.B.2-verification`). | Framework-free use cases: identity lifecycle, verification flow, attestation flow, spaces orchestration, sync workflows. | `protocol`, `ports`, plain domain types.
`ports` | `packages/wot-core/src/ports/` | Narrow capability interfaces: `IdentitySeedVault` (in `identity-vault.ts`), `StorageAdapter`, `MessagingAdapter`, `DiscoveryAdapter`, `ReplicationAdapter`, `CryptoAdapter`, `OutboxStore`, `SpaceMetadataStorage`, `Subscribable`, etc. (The earlier separate `SeedStorageAdapter.ts` port has been consolidated into `identity-vault.ts`.) | Only types from `protocol` or domain types.
`adapters` | `packages/wot-core/src/adapters/` (incl. `adapters/protocol-crypto/`), `packages/adapter-yjs/`, `packages/adapter-automerge/` | Concrete platform implementations: Web Crypto, IndexedDB, WebSocket relay, HTTP profile/vault, Yjs/Automerge document stores. | `ports`, `protocol` for wire shapes, platform APIs. Must not import application use cases as a hard dependency.
`react` | `apps/demo/src/hooks/` and `apps/demo/src/context/` today; possibly `packages/wot-react/` later | Hooks and providers that expose application use cases to the UI. | `application` use cases, view-model types.
`app` | `apps/demo/`, `apps/landing/`, `apps/benchmark/`, `packages/wot-cli/`, server bins | Composition root, runtime wiring, routes, product UI, deployment-specific glue. | Anything, but only at the composition root.

The composition root for the demo is [`apps/demo/src/runtime/appRuntime.ts`](../../apps/demo/src/runtime/appRuntime.ts). It imports concrete adapters (`WebCryptoProtocolCryptoAdapter`, `IndexedDbIdentitySeedVault`, `HttpDiscoveryAdapter`) and wires them into application workflows (`IdentityWorkflow`, `VerificationWorkflow`, `AttestationWorkflow`).

## Mapping to `wot-spec` Profiles

The conformance profiles defined in [`wot-spec/CONFORMANCE.md`](https://github.com/real-life-org/wot-spec/blob/main/CONFORMANCE.md) and [`wot-spec/conformance/manifest.json`](https://github.com/real-life-org/wot-spec/blob/main/conformance/manifest.json) are the contract a reference implementation slice must satisfy.

`wot-spec` profile | Spec entry points | Reference implementation modules
---|---|---
`wot-identity@0.1` | `wot-spec/01-wot-identity/`, `wot-spec/test-vectors/phase-1-interop.json` | `packages/wot-core/src/protocol/identity/`, `packages/wot-core/src/protocol/crypto/`, `packages/wot-core/src/adapters/protocol-crypto/web-crypto.ts`, `packages/wot-core/src/application/identity/`, `packages/wot-core/src/ports/identity-vault.ts`
`wot-trust@0.1` | `wot-spec/02-wot-trust/` | `packages/wot-core/src/protocol/trust/`, `packages/wot-core/src/application/attestations/`, `packages/wot-core/src/application/verification/`
`wot-sync@0.1` | `wot-spec/03-wot-sync/` (notably `002-sync-protokoll.md`, `003-transport-und-broker.md`, `005-gruppen.md`, `006-personal-doc.md`) | `packages/wot-core/src/protocol/sync/` including pure seq consistency, broker collision, and snapshot/full-state safety dispositions, `packages/wot-core/src/application/spaces/`, parts of `packages/wot-core/src/services/` (`EncryptedSyncService`, `GroupKeyService`, `VaultClient`, `VaultPushScheduler`), `packages/wot-core/src/ports/spaces.ts`, `packages/wot-core/src/ports/MessagingAdapter.ts`, `packages/wot-core/src/ports/ReplicationAdapter.ts`, `packages/adapter-yjs/`, `packages/adapter-automerge/`, `packages/wot-relay/`, `packages/wot-vault/`, `packages/wot-profiles/`
`wot-device-delegation@0.1` (planned, Phase 2) | `wot-spec/01-wot-identity/004-device-key-delegation.md`, `wot-spec/test-vectors/device-delegation.json` | `packages/wot-core/src/protocol/identity/device-key-binding.ts`, future `packages/wot-core/src/application/devices/`
`wot-rls@0.1` | `wot-spec/04-rls-extensions/` | Extension code outside core; not yet implemented in this repo.
`wot-hmc@0.1` | `wot-spec/05-hmc-extensions/` | `packages/wot-core/src/protocol/trust/sd-jwt-vc.ts`, `packages/wot-core/src/protocol/hmc/trust-list-delta.ts`; authority and forwarding semantics remain tracked in `real-life-org/wot-spec#43`, and trust-list-delta disclosure segment syntax remains tracked in `real-life-org/wot-spec#44`.

Coverage status for individual vectors lives in [`packages/wot-core/src/protocol/COVERAGE.md`](../../packages/wot-core/src/protocol/COVERAGE.md).

Application-level Trust coverage is tracked in [`wot-trust-conformance.md`](./wot-trust-conformance.md), including the Trust 002 online verification QR challenge and nonce-history slice.

Extension profile boundaries for `wot-rls@0.1` and `wot-hmc@0.1` are tracked in [`extension-conformance-boundary.md`](extension-conformance-boundary.md).

## Runtime Port Contract Map

Runtime/application/demo migration planning lives in [`runtime-port-contract-map.md`](runtime-port-contract-map.md). It classifies current workflow and port families as `keep`, `narrow/reshape`, `adapter-only`, `demo-only`, or `blocked pending spec/human decision`, and records which behavior-changing runtime slices should wait for protocol PRs to pass Human Gate and merge into `spec-vnext`.

## Slice Plan

Vertical slices are tracked in [`docs/reference-implementation-refactor.md`](../reference-implementation-refactor.md). At the time of this inventory the slices are:

1. Protocol rename — done.
2. Identity — landed; legacy `WotIdentity` directory has been removed. Phase 1.B.1 hardens the seed-vault contract (Candidate #1).
3. Verification — landed; legacy facade removed.
4. Attestations — landed; new attestations carry a VC-JWS.
5. Device Keys — open.
6. Spaces and Sync — first application workflow landed (`SpacesWorkflow`); CRDT adapters still own document-level sync details.

This README is the executive map. The slice plan is the detail plan. The two should stay consistent: when a slice merges, update both.

### Landed Protocol Sync Slices

- `wot-sync@0.1` Inbox ACK disposition: [`packages/wot-core/src/protocol/sync/inbox-ack-disposition.ts`](../../packages/wot-core/src/protocol/sync/inbox-ack-disposition.ts) implements the pure client-side Sync 002/003 decision for when already-processed Inbox outcomes are eligible for per-device `ack/1.0`. It does not create ACK envelopes, store Pending-Inbox state, talk to brokers, or treat ACKs as semantic acceptance, trust, display, publication, or `attestation-ack`.
- `wot-sync@0.1` Sync encryption empty-payload boundaries: [`packages/wot-core/src/protocol/sync/encryption.ts`](../../packages/wot-core/src/protocol/sync/encryption.ts) enforces the Sync 001/002 requirements that ECIES and log-payload encryption use non-empty plaintext and reject tag-only ciphertext/blob inputs. This is protocol-core validation only; it does not change wire formats, cryptographic primitives, vector bytes, runtime APIs, or sync orchestration.
- `wot-sync@0.1` Broker registration control-frame parity: [`packages/wot-core/src/protocol/sync/broker-registration-control-frames.ts`](../../packages/wot-core/src/protocol/sync/broker-registration-control-frames.ts), [`packages/wot-core/src/protocol/sync/broker-auth-transcript.ts`](../../packages/wot-core/src/protocol/sync/broker-auth-transcript.ts), and [`packages/wot-core/src/protocol/sync/broker-challenge-response-frame.ts`](../../packages/wot-core/src/protocol/sync/broker-challenge-response-frame.ts) reproduce the `phase-1-interop.json` `broker_registration_control_frames` vectors for `register`, `challenge`, `challenge-response`, and `registered`, including deterministic nonce bytes, canonical unpadded Base64URL nonce/signature fields, JCS transcript signing bytes, and exact frame JSON shapes. Runtime broker registration state, DID resolution, Ed25519 verification, nonce persistence, inbox delivery, and device-revocation wire/JWS runtime handling remain outside this slice; existing pure protocol-core broker disposition helpers remain in scope where listed above.

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
- ~~`packages/wot-core/src/services/` mixes application use cases and infrastructure. Each service needs to be classified before it can be cleanly moved to `application` or `adapters`.~~ **Resolved für Phase 1**: `services/EncryptedSyncService`, `GroupKeyService`, `ProfileService` werden ersatzlos gelöscht und als spec-zuerst neu geschriebene Workflows in `application/` neu aufgesetzt (Slices `1.B.3-encrypted-sync`, `1.B.3-group-key`, `1.B.3-profile-service`). Klassifikation entfällt — Lösch + spec-zuerst neu schreiben ersetzt sie.
- Browser-only adapters (HTTP, WebSocket, IndexedDB, LocalStorage) are still exported from the core root. They should move behind explicit adapter entry points.
- The `react` layer is not yet a package. The hooks live in `apps/demo/src/hooks/`. Extraction should wait for a second consumer.
- Coverage of `wot-sync@0.1` is incomplete: `member-update` semantics, key-rotation generation handling, and snapshot/full-state usage are tracked in slices against `wot-spec/03-wot-sync/`. The covered device revocation disposition helper is protocol-only post-signature handling for a decoded and verified `device-revoke` payload: it validates the decoded payload shape, classifies active/revoked/unknown/foreign device-list cases, emits tombstone guidance, and maps malformed payloads or foreign `deviceId` conflicts to the Sync 003 error codes. The signed `device-revoke` Broker Control-Frame wire/JWS shape is covered in protocol against `broker_device_revoke_control_frame`. Inactive/TTL cleanup remains tracked in `wot-spec#27`; broader malformed register-device semantics remain tracked in `wot-spec#28`; real broker persistence, DID resolution policy beyond caller-supplied `did:key` key material, routing, inbox deletion, and runtime error emission remain outside protocol-core. Snapshot/full-state safety is covered in protocol as pure metadata disposition only; snapshot body schemas, CRDT import/merge, coverage-head comparison, and sync orchestration remain outside that slice. The local `docs/spec/sync-protocol.md` is implementation-side working notes, not a spec entry point.
- `real-life-org/wot-spec#23` is closed: Sync 002 now requires canonical lowercase UUID-v4 for log-entry `deviceId` and `docId`, and that payload shape validation is owned by `packages/wot-core/src/protocol/sync/log-entry.ts`. The seq-consistency helper in `packages/wot-core/src/protocol/sync/seq-consistency.ts` intentionally validates only non-negative safe-integer seq values and opaque non-empty content-hash tokens; it treats `docId`/`deviceId` as opaque tokens for seq/collision classification.

## Scope of This Slice

This slice also enforces the Trust 001/002 timestamp precision requirements merged in `real-life-org/wot-spec#60` for Trust VC-JWS artifacts:

- `packages/wot-core/src/protocol/trust/attestation-vc-jws.ts` accepts only RFC3339 date-time strings with explicit timezone and whole-second precision for `validFrom` and optional `validUntil`, including normalized offset timestamps and lowercase RFC3339 separators.
- Fractional seconds are invalid, including `.000Z`.
- `nbf` and optional `exp` are integer NumericDate values and must exactly match the normalized `validFrom` and optional `validUntil` instants.
- `AttestationWorkflow` and `VerificationWorkflow` emit canonical uppercase `T`/`Z` whole-second Trust VC timestamps.

This slice adds the Trust 002 application reference path for creating Verification-Attestations as Trust 001 VC-JWS artifacts.

- `packages/wot-core/src/application/verification/verification-workflow.ts` creates initial nonce-bound Verification-Attestations and Counter-Verification-Attestations with signed top-level `inResponseTo`.
- Initial Verification-Attestation `jti` values contain the scanned QR challenge nonce for active nonce matching. The exact `jti` matching grammar remains deferred to `real-life-org/wot-spec#47`.
- Legacy `Verification` proof helpers remain source-compatible for older callers, but the new VC-JWS helpers are the Trust 002 reference path.
- Runtime behavior is deterministic and framework-free: no delivery, outbox, storage beyond existing in-memory workflow maps, contact mutation, discovery/profile publication, UI, adapter, relay, or broker behavior is introduced.
- Focused application tests cover VC-JWS verification, nonce-containing `jti`, active-challenge acceptance, pending counter-verification state, signed `inResponseTo` preservation, expiry, issuer/subject binding, and matching pending-counter acceptance.

If a follow-up reading uncovers a normative gap outside these creation helpers, raise it as a `wot-spec` PR before changing TypeScript behavior.
