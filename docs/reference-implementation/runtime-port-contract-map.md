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

Behavior-changing runtime and demo slices should wait until the relevant protocol PRs pass Human Gate and merge into `spec-vnext`. This is especially important for identity seed-protection, DID resolver semantics, sync member-update handling, key-rotation generation handling, capability/envelope verification, and personal-doc/snapshot semantics.

This document may identify likely application or port shapes, but it does not decide ambiguous `wot-spec` requirements. For Identity 001 seed protection, follow [`wot-spec` issue #45](https://github.com/real-life-org/wot-spec/issues/45) rather than deciding locally whether the reference application must use handle-based non-extractable seed APIs or may temporarily pass plaintext seed bytes through application memory.

## Application Workflow Map

Workflow | Target responsibility | Current risk | Port families involved | Classification | Next reviewable slice
---|---|---|---|---|---
Identity create, recover, unlock, delete | Application owns lifecycle, mnemonic import/create, seed-vault orchestration, session exposure, and deletion commands. Protocol owns deterministic derivation and signing rules. | `IdentitySeedVault.loadSeed` returns plaintext bytes, `ProtocolIdentitySession` keeps seed material in JS fields, session encryption uses runtime `crypto.getRandomValues`, and the demo default wordlist is a product choice that must not be confused with strict profile conformance. | `IdentitySeedVault`, `SeedStorageAdapter`, `ProtocolCryptoAdapter`, future random/clock/session ports. | `blocked pending spec/human decision` for seed non-extractability; otherwise `narrow/reshape`. | After `wot-spec` issue #45 is resolved, reshape identity vault/session APIs and add application tests for create/recover/unlock/delete without changing mnemonic or seed semantics locally first.
Profile publication and recovery | Application decides when local profile, public verifications, and accepted attestations are published or restored; discovery adapters only fetch/cache/publish signed data. | Recovery behavior in `AdapterContext` restores profile, verifications, attestations, and contacts from the profile service as demo convenience; `ProfileService` mixes DID/JWS verification with service behavior. | `DiscoveryAdapter`, `PublishStateStore`, `GraphCacheStore`, storage ports, DID resolver. | `narrow/reshape`; HTTP implementations are `adapter-only`; restore policy is partly `demo-only`. | Extract discovery/profile recovery use-case after profile JWS/DID verification authority is protocol/application-owned and discovery guarantees are clarified.
In-person verification | Application owns challenge/response state, self-verification rejection, signature creation/verification, contact update intent, and delivery command. | React hook builds relay envelopes, tracks UX state, syncs profiles, and calls storage/messaging directly. Verification signatures still use legacy JSON-shaped proof data rather than a frozen protocol artifact. | Verification storage, messaging/outbox, discovery/cache, clock/random, DID resolver. | `narrow/reshape`. | Move relay-envelope construction and contact/profile side effects behind a verification delivery workflow after trust protocol PRs are merged.
Attestation create, receive, accept, deliver | Application owns VC-JWS attestation creation/verification, local acceptance policy, delivery status, retry intent, and publish-only-accepted behavior. | Demo `AttestationService` signs transport envelopes with legacy crypto helpers, owns delivery status state, listens for receipts/acks, and mixes storage/messaging with workflow calls. | Attestation storage, messaging, outbox, delivery-status store, discovery publish state, protocol crypto. | `narrow/reshape`; delivery receipts/acks are `blocked pending spec/human decision` if treated as conformance behavior. | Create an attestation delivery workflow over messaging/outbox/storage ports after trust protocol PRs merge; keep `attestation-ack` demo-only unless specified.
Spaces create/open/list/update | Application owns space commands and metadata intent; replication adapters own CRDT document mechanics and local durability. | `SpacesWorkflow` is the right boundary, but current `ReplicationAdapter` combines document access, encryption/broadcast, membership, sync, debug key generation, and adapter-specific lifecycle. | `SpaceReplicationPort`, `ReplicationAdapter`, `SpaceMetadataStorage`, compact/persistent storage. | `keep` for `SpacesWorkflow`; `narrow/reshape` for replication ports. | Split command-level `SpaceReplicationPort` from lower-level docstore/replication adapter contracts after sync protocol PRs merge.
Space invite and member key lookup | Application owns invite command, member-key lookup policy, missing-key handling, and user-facing failure. Protocol owns DID/key-agreement decoding and validation. | `useSpaces` performs `x25519MultibaseToPublicKeyBytes` in a React hook; discovery/cache source of communication-capable DID documents is not yet explicit. | `SpaceMemberKeyDirectory`, `DiscoveryAdapter`, `GraphCacheStore`, DID resolver, messaging. | `narrow/reshape`. | Move member-key lookup into a composed application/adapter port with tests for missing key, invalid multibase, cached key, and profile-derived key.
Member removal and key rotation | Application owns removal command, policy, pending/future/stale rotation handling, and recovery workflow. Protocol owns member-update and key-rotation validation. | `GroupKeyService` owns random generation, in-memory state, and generation disposition; CRDT adapters import it directly. Message naming and validation authority are still open in the demo map. | Key-management port, durable pending rotation store, replication, messaging, protocol crypto. | `blocked pending spec/human decision`. | Wait for sync member-update/key-rotation protocol decisions, then introduce a key-management workflow plus durable pending-rotation port before changing CRDT adapters.
Sync recovery | Application owns startup/reconnect ordering, local-first load, relay auth intent, personal-doc-first sync, outbox flush, discovery retry, blocked-by-key retry, and vault refresh policy. | `AdapterContext` owns most orchestration inside React provider setup; Yjs/Automerge adapters also own vault refresh, sync-request, and personal-doc behavior. | Messaging, outbox, replication, discovery, vault, metadata/compact stores, graph cache, runtime reset/storage-management. | `narrow/reshape`; much of current orchestration is `demo-only`. | Add a framework-free sync recovery workflow after sync semantics are stable; keep React provider as composition and state display only.
Local reset and identity-change cleanup | App runtime owns destructive storage cleanup decisions and user-visible reset behavior. | Demo deletes multiple IndexedDB databases from React/provider and page paths. This may be correct product behavior but is not reference application semantics. | Runtime reset adapter, storage-management port, CRDT adapter cleanup hooks. | `demo-only` until explicitly specified. | Add a demo runtime reset adapter/factory if cleanup remains needed; do not promote database names into core.

## Port Family Classification

Port family | Current examples | Target responsibility | Current risk | Classification | Next reviewable slice
---|---|---|---|---|---
Identity seed vault | `IdentitySeedVault`, `SeedStorageAdapter`, `SeedStorageIdentityVault` | Protect, store, unlock, delete, and optionally session-cache identity seed material or opaque seed handles. | Current API returns plaintext seed bytes; strict non-extractability is unresolved. | `blocked pending spec/human decision` | Use `wot-spec` issue #45 as the prerequisite for a seed-vault hardening slice.
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
Key management | `GroupKeyService` | Application sync workflow and durable state for group keys, rotations, pending/future rotations, and missing-key recovery. | Service owns random generation and in-memory state; adapters import it as hard dependency. | `blocked pending spec/human decision` | Wait for member-update/key-rotation protocol decisions, then introduce narrow key-management ports.
Vault and personal-doc persistence | `VaultClient`, `VaultPushScheduler`, adapter vault URLs | Push/pull encrypted personal or space state as infrastructure selected by composition. | CRDT adapters hard-wire vault client/scheduler behavior and URLs. | `adapter-only` | Move vault HTTP and scheduling behind explicit adapter entry points; application chooses refresh/push timing.
Metadata and compact stores | `SpaceMetadataStorage`, `PersonalDocSpaceMetadataStorage`, `CompactStorageManager` | Persist metadata and adapter optimization snapshots without replacing required log catch-up semantics. | Compact/debug metrics are exposed from core storage and wired in React provider. | `adapter-only`; debug metrics are `demo-only` unless explicitly kept | Define storage-management/debug entry points before deleting root exports.
Authorization/capabilities | `AuthorizationAdapter`, capability helpers, server auth | Enforce local/server authorization using protocol capability parsing and verification. | Legacy capability/envelope helpers may diverge from protocol modules; server packages duplicate checks. | `blocked pending spec/human decision` for protocol shape; otherwise `narrow/reshape` | Align capability/envelope verification with merged protocol modules before server/runtime behavior changes.
Subscribable/reactive state | `Subscribable`, `SpaceListSubscription` | Small reactive binding for application/view-model consumers. | Useful but inconsistent shape across ports. | `keep` concept; `narrow/reshape` signatures | Normalize only when touching each workflow port; avoid broad reactive abstraction now.

## Demo Import Boundary

The demo may import concrete adapters only at composition roots or temporary adapter shims. Current composition is split between `apps/demo/src/runtime/appRuntime.ts` and `apps/demo/src/context/AdapterContext.tsx`; future slices should reduce the React provider's responsibilities, but this map does not move imports.

May remain in the composition root:

- `@web_of_trust/core/application` workflow constructors when wiring runtime instances.
- Concrete browser/runtime adapters from `@web_of_trust/core/adapters` and `@web_of_trust/core/protocol-adapters` until explicit adapter entry points exist.
- Dynamic `@web_of_trust/adapter-yjs` and `@web_of_trust/adapter-automerge` selection.
- Runtime URLs and Vite environment handling.
- Demo-local adapter stores such as outbox, graph cache, publish state, row mappers, and local cache stores.
- Runtime reset and storage cleanup adapters, if later extracted from React/page code.

Must move behind application workflows or ports before being treated as reference behavior:

- `GroupKeyService` construction passed directly into CRDT adapters.
- `CompactStorageManager`, `getMetrics`, and storage debug types used as general workflow dependencies.
- Protocol decoding in React hooks, including `x25519MultibaseToPublicKeyBytes` in `useSpaces`.
- Relay envelope construction and signing in `useVerification` and demo attestation services.
- `signEnvelope` from legacy `@web_of_trust/core/crypto` and `createResourceRef` from broad `@web_of_trust/core/types` in app services.
- Profile/discovery recovery orchestration embedded in `AdapterContext`.
- Direct CRDT database deletion imports from UI/page/reset code.
- Any direct import from `@web_of_trust/core/services` in hooks, contexts, or adapters once the replacement workflow exists.

Adapter shims may temporarily import concrete adapter packages when they only translate to port-shaped behavior. They must not introduce new compatibility commitments for flattened root exports, legacy services, or app-local schemas.

## Blocked Or Human-Decision Items

Item | Blocking decision | Required handling
---|---|---
Identity 001 seed protection | Does strict conformance require handle-based or platform non-extractable seed APIs, or is an interim plaintext-in-memory browser workflow acceptable under a documented threat model? | Do not decide locally. Reference [`wot-spec` issue #45](https://github.com/real-life-org/wot-spec/issues/45) and wait before a behavior-changing seed-vault slice.
Space member-update/key-rotation naming and validation | Confirm message names, signer policy, generation rules, stale/future handling, and durable pending behavior. | Wait for relevant sync protocol PRs to pass Human Gate and merge into `spec-vnext`.
Envelope/capability authority | Decide whether legacy capability/envelope helpers are migrated into protocol sync modules or replaced by newer protocol modules. | Do not create runtime compatibility promises for legacy helpers.
Discovery recovery guarantees | Decide which restore behavior is reference application behavior versus demo convenience. | Keep current restore map as planning only; do not claim conformance.
Delivery receipts and `attestation-ack` | Decide whether any receipt/ack behavior belongs to a conformance profile. | Treat current handling as demo-only planning unless a spec/profile specifies receipt or ack semantics.
Root export compatibility | Decide public migration policy for flattened root exports and adapter/service exports. | This slice creates no compatibility commitment.

## Follow-Up Runner Task Candidates

Candidate | Prerequisites | Allowed scope | Blockers
---|---|---|---
Identity seed-vault contract hardening | `wot-spec` issue #45 resolved or explicitly deferred by humans; relevant protocol PR merged to `spec-vnext`. | `packages/wot-core/src/application/identity/`, `packages/wot-core/src/ports/identity-vault.ts`, seed-vault adapters, focused identity application/adapter tests, reference docs. | Do not start if the task must decide handle-based versus plaintext-in-memory seed behavior.
Discovery/profile recovery workflow | Profile JWS/DID verification authority clarified in protocol/application; discovery recovery guarantees clarified. | `packages/wot-core/src/application/`, `packages/wot-core/src/ports/DiscoveryAdapter.ts`, discovery/cache adapters, demo composition, focused tests, docs. | Blocked if restore semantics are normative but not specified.
Verification delivery workflow | Trust protocol PRs merged; envelope/capability signing authority clarified. | Verification application workflow, messaging/outbox ports, demo hook/service migration, tests, docs. | Blocked if relay envelope shape or verification artifact shape is ambiguous.
Attestation delivery-status workflow | Trust protocol PRs merged; delivery receipts/ack classified as profile behavior or demo-only. | Attestation application workflow, outbox/delivery-status ports, demo service migration, tests, docs. | Do not claim receipt/ack conformance without spec coverage.
Member-key directory extraction | DID communication-capable document source and cache/profile lookup policy clarified. | `packages/wot-core/src/application/spaces/`, `packages/wot-core/src/ports/spaces.ts`, discovery/cache adapters, demo `useSpaces` migration, tests. | Blocked if key-agreement source remains ambiguous.
Key-rotation and pending-key workflow | Sync member-update/key-rotation PRs merged to `spec-vnext`. | Application sync/spaces workflow, key-management ports, durable pending stores, Yjs/Automerge adapter integration, tests, docs. | Blocked on message naming, generation semantics, and durable pending requirements.
Sync recovery orchestrator | Sync recovery ordering and personal-doc/snapshot expectations clarified. | Framework-free sync application workflow, runtime composition, messaging/outbox/discovery/replication/vault ports, demo provider migration, tests. | Blocked if application versus adapter ownership of vault refresh and sync-request remains undecided.
Adapter entry-point cleanup | Public compatibility decision for root exports; replacement entry points designed. | Package export files, adapter entry points, import migrations, docs, tests. | Out of scope for this documentation-only slice and must not preserve flattened root exports by accident.
Demo runtime reset adapter | Human decision that current identity-change cleanup is product behavior. | Demo runtime/adapters only, reset service/page imports, tests if behavior changes, docs. | Blocked if cleanup semantics are treated as reference application behavior without a use-case spec.

## Traceability

This is a documentation-only bridge from the current reference implementation inventories to future runtime migration tasks. It links to `docs/reference-implementation/README.md`, `docs/reference-implementation/demo-consumer-map.md`, `docs/reference-implementation/legacy-boundary-map.md`, `docs/reference-implementation/wot-identity-conformance.md`, the `../wot-spec` conformance and architecture inputs listed above, and [`wot-spec` issue #45](https://github.com/real-life-org/wot-spec/issues/45).

No generated row in this map is a conformance claim. Runtime behavior, package exports, application workflows, adapters, schemas, tests, demo code, and normative spec files remain unchanged by this slice.
