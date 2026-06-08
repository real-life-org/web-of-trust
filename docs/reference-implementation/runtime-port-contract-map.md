# Runtime Port Contract Map

> **Status:** Draft planning map. This document is non-normative and documentation-only. It does not claim runtime conformance, freeze public API contracts, or change implementation behavior.

This map bridges protocol-core PRs to the runtime, application, adapter, and demo migration tasks that should follow after the relevant protocol decisions pass Human Gate and merge into `spec-vnext`.

## Inputs And Scope

This document was produced from the reference implementation inventories and the spec-side architecture documents named by the current slice:

- `docs/reference-implementation/README.md`
- `docs/reference-implementation/demo-consumer-map.md`
- `docs/reference-implementation/legacy-boundary-map.md`
- `docs/reference-implementation/wot-identity-conformance.md`
- `../wot-spec/CONFORMANCE.md`
- `../wot-spec/conformance/manifest.json`
- `../wot-spec/ARCHITECTURE.md`
- `../wot-spec/IMPLEMENTATION-ARCHITECTURE.md`
- `../wot-spec/01-wot-identity/001-identitaet-und-schluesselableitung.md`
- [`wot-spec` issue #45](https://github.com/real-life-org/wot-spec/issues/45)

Allowed local scope for this slice is only `docs/reference-implementation/runtime-port-contract-map.md` and `docs/reference-implementation/README.md`. No runtime code, package exports, application workflows, adapters, demo code, schemas, tests, or spec files are changed here.

## Classification Labels

Label | Meaning in this map
---|---
`keep` | The current port family is close enough to the target responsibility that a later slice can preserve the concept while tightening names, tests, or entry points.
`narrow/reshape` | The concept is needed, but the current interface is too broad, adapter-shaped, app-shaped, or mixed with workflow semantics.
`adapter-only` | The current implementation can remain as concrete runtime infrastructure behind a port, but must not define protocol or application behavior.
`demo-only` | The behavior belongs to the demo product, React state, diagnostics, or local runtime composition; it is not part of reference core.
`blocked pending spec/human decision` | Runtime behavior must not be changed until an open protocol or human decision is resolved.

## Runtime Readiness Rule

Behavior-changing runtime and demo slices should wait until the relevant protocol PRs pass Human Gate and merge into `spec-vnext`. This is especially important for DID resolver semantics, sync member-update handling, key-rotation generation handling, capability/envelope verification, and personal-doc/snapshot semantics. Identity seed-protection is no longer blocked at the spec-decision level: wot-spec PR #74 / ADR 0001 defines the three-layer conformance bar.

This document may identify likely application or port shapes, but it does not decide ambiguous `wot-spec` requirements. For Identity 001 seed protection, follow [`wot-spec` ADR 0001](https://github.com/real-life-org/wot-spec/blob/main/decisions/0001-identity-seed-protection-conformance-bar.md): encrypted persistence and no raw-seed-returning application/port API are MUST-level requirements, while transient in-process plaintext is Runtime MAY+SHOULD with minimized lifetime and non-extractable handles where available.

## Application Workflow Map

Workflow | Target responsibility | Current risk | Port families involved | Classification | Next reviewable slice
---|---|---|---|---|---
Identity create, recover, unlock, delete | Application owns lifecycle, mnemonic import/create, seed-vault orchestration, session exposure, and deletion commands. Protocol owns deterministic derivation and signing rules. | The reference `IdentitySeedVault` unlock path now returns an operation-shaped handle instead of raw seed bytes, `ProtocolIdentitySession` no longer stores BIP39 seed fields directly, and the reference public surface (`@web_of_trust/core`, `@web_of_trust/core/application`) no longer exports `WotIdentity`. The CLI headless client now constructs `IdentityWorkflow` for recovery instead of `WotIdentity`. Remaining risk: legacy `SeedStorageAdapter` and `WotIdentity` files still exist as direct-internal-source raw-seed surfaces for legacy-only tests, runtime randomness is not ported, and the demo default wordlist is a product choice that must not be confused with strict profile conformance. | `IdentitySeedVault`, `SeedStorageAdapter`, `ProtocolCryptoAdapter`, future random/clock/session ports. | `narrow/reshape`; spec decision resolved by wot-spec PR #74. | Continue legacy purge by deleting the legacy `WotIdentity`/`SeedStorage` source files and direct-internal-source tests after remaining callers migrate to `IdentityWorkflow`/`PublicIdentitySession`, and adding runtime-specific non-extractable-handle posture docs.
Profile publication and recovery | Application decides when local profile, public verifications, and accepted attestations are published or restored; discovery adapters only fetch/cache/publish signed data. | Recovery behavior in `AdapterContext` restores profile, verifications, attestations, and contacts from the profile service as demo convenience; `ProfileService` mixes DID/JWS verification with service behavior. | `DiscoveryAdapter`, `PublishStateStore`, `GraphCacheStore`, storage ports, DID resolver. | `narrow/reshape`; HTTP implementations are `adapter-only`; restore policy is partly `demo-only`. | Extract discovery/profile recovery use-case after profile JWS/DID verification authority is protocol/application-owned and discovery guarantees are clarified.
In-person verification | Application owns challenge/response state, self-verification rejection, signature creation/verification, contact update intent, and delivery command. | React hook builds relay envelopes, tracks UX state, syncs profiles, and calls storage/messaging directly. Verification signatures still use legacy JSON-shaped proof data rather than a frozen protocol artifact. | Verification storage, messaging/outbox, discovery/cache, clock/random, DID resolver. | `narrow/reshape`. | Move relay-envelope construction and contact/profile side effects behind a verification delivery workflow after trust protocol PRs are merged.
Attestation create, receive, publish, deliver | Application owns VC-JWS attestation creation/verification, publish-consent (`accepted` flag — Holder choice over profile visibility), transport delivery status, and retry intent. **No Trust-level acceptance signal** exists (Trust 001 Z.147). | Demo `AttestationService` signs transport envelopes with legacy crypto helpers, owns transport-status state, and mixes storage/messaging with workflow calls. Core `AttestationDeliveryService` removed in 1.B.2 (was dead code). | Attestation storage, messaging, outbox, transport-status store, discovery publish state, protocol crypto. | `narrow/reshape`. | Create an attestation delivery workflow over messaging/outbox/storage ports (deferred B2.1) after envelope/capability authority is settled. Publish-consent stays as Holder-controlled profile flag; transport-level ACK comes from Sync 003 `ack/1.0` only.
Spaces create/open/list/update | Application owns space commands and metadata intent; replication adapters own CRDT document mechanics and local durability. | `SpacesWorkflow` is the right boundary, but current `ReplicationAdapter` combines document access, encryption/broadcast, membership, sync, debug key generation, and adapter-specific lifecycle. | `SpaceReplicationPort`, `ReplicationAdapter`, `SpaceMetadataStorage`, compact/persistent storage. | `keep` for `SpacesWorkflow`; `narrow/reshape` for replication ports. | Split command-level `SpaceReplicationPort` from lower-level docstore/replication adapter contracts after sync protocol PRs merge.
Space invite and member key lookup | Application owns invite command, member-key lookup policy, missing-key handling, and user-facing failure. Protocol owns DID/key-agreement decoding and validation. | `useSpaces` performs `x25519MultibaseToPublicKeyBytes` in a React hook; discovery/cache source of communication-capable DID documents is not yet explicit. | `SpaceMemberKeyDirectory`, `DiscoveryAdapter`, `GraphCacheStore`, DID resolver, messaging. | `narrow/reshape`. | Move member-key lookup into a composed application/adapter port with tests for missing key, invalid multibase, cached key, and profile-derived key.
Member removal and key rotation | Application owns removal command, policy, pending/future/stale rotation handling, and recovery workflow. Protocol owns member-update and key-rotation validation. | The `KeyManagementPort` now stores keys by generation, the `application/sync/group-key-workflow.ts` owns create/rotate/apply/import, and the pure protocol classifier `evaluateKeyRotationDisposition` decides apply/ignore-stale-or-duplicate/future-buffer. CRDT adapters take a `keyManagement` DI param (default `InMemoryKeyManagementAdapter`) instead of importing a service. Remaining risk: key persistence is still in-memory by default (durable store is a follow-up sub-slice), and message naming/validation authority is still open in the demo map. | Key-management port, durable pending rotation store, replication, messaging, protocol crypto. | `narrow/reshape`. | Add the durable, crash-safe key/pending-rotation store behind the existing `KeyManagementPort`, then settle member-update/key-rotation message naming and validation authority.
Sync recovery | Application owns startup/reconnect ordering, local-first load, relay auth intent, personal-doc-first sync, outbox flush, discovery retry, blocked-by-key retry, and vault refresh policy. | `AdapterContext` owns most orchestration inside React provider setup; Yjs/Automerge adapters also own vault refresh, sync-request, and personal-doc behavior. | Messaging, outbox, replication, discovery, vault, metadata/compact stores, graph cache, runtime reset/storage-management. | `narrow/reshape`; much of current orchestration is `demo-only`. | Add a framework-free sync recovery workflow after sync semantics are stable; keep React provider as composition and state display only.
Local reset and identity-change cleanup | App runtime owns destructive storage cleanup decisions and user-visible reset behavior. | Demo deletes multiple IndexedDB databases from React/provider and page paths. This may be correct product behavior but is not reference application semantics. | Runtime reset adapter, storage-management port, CRDT adapter cleanup hooks. | `demo-only` until explicitly specified. | Add a demo runtime reset adapter/factory if cleanup remains needed; do not promote database names into core.

## Port Family Classification

Port family | Current examples | Target responsibility | Current risk | Classification | Next reviewable slice
---|---|---|---|---|---
Identity seed vault | `IdentitySeedVault` (port lebt in `packages/wot-core/src/ports/identity-vault.ts`), `IndexedDbIdentitySeedVault` | Protect, store, unlock, delete, and optionally session-cache identity seed material or opaque seed handles. | Reference `IdentitySeedVault` now avoids raw-seed-returning unlock APIs, the public `@web_of_trust/core/ports` barrel no longer re-exports any low-level `SeedStorageAdapter`, and `@web_of_trust/core`/`@web_of_trust/core/application` no longer export `WotIdentity`. `IndexedDbIdentitySeedVault` is the canonical browser seed-vault adapter; lower-level seed-storage internals leben hinter dieser Boundary und sind nicht öffentlich. | `narrow/reshape` | Follow-up: runtime-specific non-extractable-handle posture dokumentieren und letzte Legacy-`SeedStorage`-Reste in Adapter-Internals entfernen.
Protocol crypto | `ProtocolCryptoAdapter`, `WebCryptoProtocolCryptoAdapter` | Runtime implementation of protocol crypto primitives needed by deterministic protocol modules. | Generally right boundary, but application identity still signs directly with `@noble/ed25519` and runtime randomness is not ported. | `keep` with focused reshaping | Route application signing/encryption through protocol helpers and explicit crypto/random ports after protocol PRs merge.
Application crypto | `CryptoAdapter`, `WebCryptoAdapter` | Non-protocol runtime crypto capability for app/adapters where protocol primitives are not the authority. | Name overlaps with protocol crypto and can hide browser-global usage in shared core. | `narrow/reshape` | Rename/split by capability when callers are migrated; avoid new root-export commitments.
Storage and reactive storage | `StorageAdapter`, `ReactiveStorageAdapter`, demo Automerge/Yjs storage adapters | Persist app-domain identity profile, contacts, verifications, attestations, metadata, and UI subscriptions. | Broad app-shaped interface spans many workflows and storage models. | `narrow/reshape` | Split workflow-specific stores before migrating hooks/services; add contract tests per store.
Messaging | `MessagingAdapter`, `WebSocketMessagingAdapter`, `OutboxMessagingAdapter` | Deliver already-authorized envelopes, surface connection state, receipts, and retry hooks without defining message validity. | Current port includes transport registration/resolution and receipt behavior; app hooks build envelopes directly. | `narrow/reshape` | Define message delivery and transport-resolution ports after envelope/capability protocol authority is settled.
Outbox | `OutboxStore`, local outbox stores | Durable retry queue for messages selected by application workflows. | Current metadata is useful but delivery semantics and skipped message types are demo policy. | `keep` for queue concept; `narrow/reshape` policy | Add contract tests for idempotent enqueue/dequeue/retry count; keep skip policy in composition.
Discovery/profile | `DiscoveryAdapter`, `OfflineFirstDiscoveryAdapter`, `HttpDiscoveryAdapter` | Resolve/publish signed public profile, DID document, public verifications, and accepted public attestations; cache without becoming trust authority. | Adapter verifies JWS/profile data and restore policy is mixed into demo provider. | `narrow/reshape`; HTTP/cache implementations are `adapter-only` | Extract protocol verification first, then split discovery resolver, publish, cache, and restore use-cases.
Graph/profile cache | `GraphCacheStore`, `GraphCacheService`, demo cache stores | Cache offline display and lookup data; never define trust validity. | Hook imports `GraphCacheService` directly; cache freshness can be mistaken for authority. | `adapter-only` for stores, `narrow/reshape` for service | Create cache/query view-model or discovery application use-case after storage split.
Publish state | `PublishStateStore`, demo publish-state store | Track dirty public artifacts and retry publication. | Correct mechanism, but currently bound to demo storage and provider orchestration. | `keep` with adapter-only implementations | Move `syncPending` triggering into discovery publish workflow.
Replication and spaces | `ReplicationAdapter`, `SpaceReplicationPort`, Yjs/Automerge adapters | Implement space commands, CRDT doc access, membership operations, and sync requests behind application workflows. | Current `ReplicationAdapter` is broad and includes lifecycle, document handles, membership, sync, and debug key generation. | `narrow/reshape` | Split command port, doc handle port, membership/key port, and diagnostics after sync PRs merge.
Member-key directory | `SpaceMemberKeyDirectory` | Resolve a member encryption public key from DID document/profile/cache sources or return missing-key. | Good narrow concept, but current implementation lives inside a React hook. | `keep` concept; move implementation | Add adapter/application implementation outside React with profile/cache/DID resolver tests.
Key management | `KeyManagementPort`, `InMemoryKeyManagementAdapter`, `application/sync/group-key-workflow.ts` | Application sync workflow and durable state for group keys, rotations, pending/future rotations, and missing-key recovery. | Port + default in-memory adapter + group-key workflow now exist; adapters receive the port via a `keyManagement` DI param. State is still in-memory by default; durable storage and missing-key/pending-rotation recovery remain follow-up work. | `keep` (now in correct layer) | Add the durable key/pending-rotation store behind the existing port; settle pending/future recovery semantics after sync protocol decisions.
Vault and personal-doc persistence | `VaultClient`, `VaultPushScheduler`, adapter vault URLs | Push/pull encrypted personal or space state as infrastructure selected by composition. | CRDT adapters hard-wire vault client/scheduler behavior and URLs. | `adapter-only` | Move vault HTTP and scheduling behind explicit adapter entry points; application chooses refresh/push timing.
Metadata and compact stores | `SpaceMetadataStorage`, `PersonalDocSpaceMetadataStorage`, `CompactStorageManager` | Persist metadata and adapter optimization snapshots without replacing required log catch-up semantics. | Compact/debug metrics are exposed from core storage and wired in React provider. | `adapter-only`; debug metrics are `demo-only` unless explicitly kept | Define storage-management/debug entry points before deleting root exports.
Authorization/capabilities | `AuthorizationAdapter`, capability helpers (now `application/authorization/capabilities.ts`), server auth | Enforce local/server authorization using non-normative UCAN-style capability tokens. | Resolved by [wot-spec#95](https://github.com/real-life-org/wot-spec/issues/95): capabilities are non-normative app-level building blocks (not spec-protocol). Both `AuthorizationAdapter` port and `capabilities.ts` moved to `application/authorization/` in slice 1.A.2. | `keep` (now in correct layer) | Future: define explicit revocation/expiration policy in application workflows when needed; `InMemoryAuthorizationAdapter` covers POC/tests.
Subscribable/reactive state | `Subscribable`, `SpaceListSubscription` | Small reactive binding for application/view-model consumers. | Useful but inconsistent shape across ports. | `keep` concept; `narrow/reshape` signatures | Normalize only when touching each workflow port; avoid broad reactive abstraction now.

## Demo Import Boundary

The demo may import concrete adapters only at composition roots or temporary adapter shims. Current composition is split between `apps/demo/src/runtime/appRuntime.ts` and `apps/demo/src/context/AdapterContext.tsx`; future slices should reduce the React provider's responsibilities, but this map does not move imports.

May remain in the composition root:

- `@web_of_trust/core/application` workflow constructors when wiring runtime instances.
- Concrete browser/runtime adapters from `@web_of_trust/core/adapters` (incl. subpath `@web_of_trust/core/protocol-adapters` → `src/adapters/protocol-crypto/`) until explicit adapter entry points exist.
- Dynamic `@web_of_trust/adapter-yjs` and `@web_of_trust/adapter-automerge` selection.
- Runtime URLs and Vite environment handling.
- Demo-local adapter stores such as outbox, graph cache, publish state, row mappers, and local cache stores.
- Runtime reset and storage cleanup adapters, if later extracted from React/page code.

Must move behind application workflows or ports before being treated as reference behavior:

- `CompactStorageManager`, `getMetrics`, and storage debug types used as general workflow dependencies.
- Protocol decoding in React hooks, including `x25519MultibaseToPublicKeyBytes` in `useSpaces`.
- Relay envelope construction and signing in `useVerification` and demo attestation services.
- `signEnvelope` from legacy `@web_of_trust/core/crypto` and `createResourceRef` from broad `@web_of_trust/core/types` in app services.
- Profile/discovery recovery orchestration embedded in `AdapterContext`.
- Direct CRDT database deletion imports from UI/page/reset code.
- Any direct import from `@web_of_trust/core/services` in hooks, contexts, or adapters once the replacement workflow exists.

Adapter shims may temporarily import concrete adapter packages when they only translate to port-shaped behavior. They must not introduce new compatibility commitments for flattened root exports, legacy services, or app-local schemas.

## Blocked Or Human-Decision Items

> **Status 2026-06-07**: Alle 6 Items sind durch wot-spec-Merges und Spec-Recheck aufgelöst — siehe `migration/PHASE-1-WOT-CORE-DEMO.md#status-quo`. Liste bleibt als historischer Audit-Trail; **nicht mehr blockierend für Implementation**.

Item | Resolution | Spec-Anker
---|---|---
Identity 001 seed protection | Resolved durch wot-spec PR #74 / ADR 0001. Drei-Layer-Bar: Persistence MUST encrypted, API MUST not expose raw seed, Runtime MAY transient plaintext + SHOULD non-extractable. | `wot-spec/decisions/0001-identity-seed-protection-conformance-bar.md`
Space member-update/key-rotation naming and validation | Resolved durch Sync 005. Member-update-Validation in §Verantwortlichkeitsgrenzen; key-rotation normativ als Application-Workflow. | `03-wot-sync/005-*.md` Z.243-252 + §Verantwortlichkeitsgrenzen
Envelope/capability authority | Resolved durch [wot-spec#95](https://github.com/real-life-org/wot-spec/issues/95) (capabilities non-normative → `application/authorization/`) + [wot-spec#96](https://github.com/real-life-org/wot-spec/issues/96) (envelope-auth widerspricht Sync 003 → bleibt deprecated in `crypto/` bis Phase 2+). Beide Moves in Slice 1.A.2 ausgeführt; `src/crypto/` reduziert auf envelope-auth-only. | `03-wot-sync/003-*.md` Z.343/410 + wot-spec#95/#96
Discovery recovery guarantees | Resolved durch Sync 004 Recovery-Sektion. Restore-Semantik ist normiert. | `03-wot-sync/004-discovery.md` Z.115-120
Delivery receipts and `attestation-ack` | Resolved durch Trust 001 + CONFORMANCE: `wot-trust@0.1` definiert **keine** `attestation-ack` und keine semantische Annahmebestätigung. Demo-spezifische Receipt-Modellierung wird in 1.B.2 entfernt (nicht migriert). Sync 003 `ack/1.0` bleibt als Transport-Inbox-ACK normativ getrennt. | `02-wot-trust/001-*.md` Z.147 + `CONFORMANCE.md` Z.69
Root export compatibility | Resolved durch Phase 1.A/1.C. `package.json` `exports`-Map ersetzt flattened root export. Keine Compat-Shims (siehe Master-Plan § Operative Anmerkungen "Kein Legacy-Workaround-Vokabular"). | `migration/PHASE-1-WOT-CORE-DEMO.md#1c-standalone-publikation`

## Follow-Up Runner Task Candidates

Candidate | Prerequisites | Allowed scope | Blockers
---|---|---|---
Identity seed-vault contract hardening | Complete initial slice against wot-spec PR #74 / ADR 0001. | `packages/wot-core/src/application/identity/`, `packages/wot-core/src/ports/identity-vault.ts`, seed-vault adapters, focused identity application/adapter tests, reference docs. | Follow-up should target legacy raw-seed surface isolation/removal, not the already-decided conformance bar.
Discovery/profile recovery workflow | Profile JWS/DID verification authority clarified in protocol/application; discovery recovery guarantees clarified. | `packages/wot-core/src/application/`, `packages/wot-core/src/ports/DiscoveryAdapter.ts`, discovery/cache adapters, demo composition, focused tests, docs. | Blocked if restore semantics are normative but not specified.
Verification delivery workflow | Trust protocol PRs merged; envelope/capability signing authority clarified. | Verification application workflow, messaging/outbox ports, demo hook/service migration, tests, docs. | Blocked if relay envelope shape or verification artifact shape is ambiguous.
Attestation delivery-status workflow | Trust protocol PRs merged; delivery receipts/ack classified as profile behavior or demo-only. | Attestation application workflow, outbox/delivery-status ports, demo service migration, tests, docs. | Do not claim receipt/ack conformance without spec coverage.
Member-key directory extraction | DID communication-capable document source and cache/profile lookup policy clarified. | `packages/wot-core/src/application/spaces/`, `packages/wot-core/src/ports/spaces.ts`, discovery/cache adapters, demo `useSpaces` migration, tests. | Blocked if key-agreement source remains ambiguous.
Key-rotation and pending-key workflow | Sync member-update/key-rotation PRs merged to `spec-vnext`. | Application sync/spaces workflow, key-management ports, durable pending stores, Yjs/Automerge adapter integration, tests, docs. | Blocked on message naming, generation semantics, and durable pending requirements.
Sync recovery orchestrator | Sync recovery ordering and personal-doc/snapshot expectations clarified. | Framework-free sync application workflow, runtime composition, messaging/outbox/discovery/replication/vault ports, demo provider migration, tests. | Blocked if application versus adapter ownership of vault refresh and sync-request remains undecided.
Adapter entry-point cleanup | Public compatibility decision for root exports; replacement entry points designed. | Package export files, adapter entry points, import migrations, docs, tests. | Out of scope for this documentation-only slice and must not preserve flattened root exports by accident.
Demo runtime reset adapter | Human decision that current identity-change cleanup is product behavior. | Demo runtime/adapters only, reset service/page imports, tests if behavior changes, docs. | Blocked if cleanup semantics are treated as reference application behavior without a use-case spec.

## Traceability

This is a bridge from the current reference implementation inventories to future runtime migration tasks. It links to `docs/reference-implementation/README.md`, `docs/reference-implementation/demo-consumer-map.md`, `docs/reference-implementation/legacy-boundary-map.md`, `docs/reference-implementation/wot-identity-conformance.md`, the `../wot-spec` conformance and architecture inputs listed above, and the seed-protection decision accepted in `../wot-spec/decisions/0001-identity-seed-protection-conformance-bar.md`.

No generated row in this map is a conformance claim. Runtime behavior, package exports, application workflows, adapters, schemas, tests, demo code, and normative spec files remain unchanged by this slice.
