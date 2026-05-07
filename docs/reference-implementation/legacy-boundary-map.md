# Legacy Boundary Map

This inventory classifies the current TypeScript implementation before replacement work. It is non-normative and follows the spec-side architecture notes in [`README.md#spec-landkarte`](../../../wot-spec/README.md#spec-landkarte), [`ARCHITECTURE.md`](../../../wot-spec/ARCHITECTURE.md), [`IMPLEMENTATION-ARCHITECTURE.md`](../../../wot-spec/IMPLEMENTATION-ARCHITECTURE.md), [`CONFORMANCE.md`](../../../wot-spec/CONFORMANCE.md), and [`conformance/manifest.json`](../../../wot-spec/conformance/manifest.json).

The purpose is not to preserve legacy APIs by default. Proven mechanisms should be kept only when they can be mapped to explicit protocol, application, port, adapter, app, or server-infrastructure responsibilities.

## Classification Labels

Label | Meaning
---|---
`reference-candidate` | Can become part of the reference implementation after conformance review, test-vector coverage, and dependency-boundary checks.
`rewrite` | Contains useful intent, but the current shape mixes responsibilities or encodes behavior outside the target layer.
`adapter-only` | Keep as concrete implementation behind a port. It must not define protocol authority or application semantics.
`demo-only` | Useful for the demo app or product UX, but not part of the reference protocol/application core.
`server-infra` | Reference service infrastructure for relay, discovery/profile, vault, or CLI operation. It may exercise protocol objects but must not define normative app semantics.
`remove` | Legacy duplicate, transitional shim, debug surface, or obsolete compatibility path to delete after replacement criteria are met.

## Module Map

Current area | Classification | Target boundary | Notes
---|---|---|---
`packages/wot-core/src/protocol/` | `reference-candidate` | Protocol | Closest to the spec source of truth: deterministic identity, crypto encoding, JCS/JWS, DID, trust, sync, capability, membership, and personal-doc helpers. Keep pure and test-vector-driven.
`packages/wot-core/src/protocol-adapters/` | `adapter-only` | Adapter for protocol crypto ports | `WebCryptoProtocolCryptoAdapter` is useful as a browser/runtime implementation of `ProtocolCryptoAdapter`; it must not become protocol authority.
`packages/wot-core/src/application/` | `rewrite` | Application | Workflows are the right target shape, but identity still uses runtime `crypto.getRandomValues` inside session encryption and direct `@noble/ed25519` signing. Keep workflow intent; move deterministic signing/encryption rules to `protocol` and randomness/seed storage behind ports.
`packages/wot-core/src/ports/` | `reference-candidate` | Ports | Good target boundary for storage, messaging, discovery, replication, outbox, authorization, and identity vault. Review each interface for app-specific shape before freezing as reference ports.
`packages/wot-core/src/types/` | `rewrite` | Protocol/domain types | Several types are useful shared domain shapes, but they live beside legacy app/service assumptions. Split spec payload types into `protocol`; leave app view/storage types outside protocol authority.
`packages/wot-core/src/crypto/` | `rewrite` | Protocol or remove | Duplicates protocol crypto concerns (`did`, `jws`, encoding, capabilities, envelope auth). Preserve mechanisms only by moving or aliasing them to spec-near `protocol/crypto`, `protocol/identity`, and `protocol/sync`; delete duplicate authority after consumers migrate.
`packages/wot-core/src/identity/` | `rewrite` | Application plus ports | `WotIdentity` and `SeedStorage` predate the clearer workflow/port split. Keep only behavior that maps to `IdentityWorkflow` or `IdentitySeedVault`; do not preserve the old identity API by default.
`packages/wot-core/src/services/ProfileService.ts` | `rewrite` | Application/service plus discovery adapter | Mixes profile publication/verification, DID document shaping, legacy JWS helpers, and x25519 DID service material. Preserve profile verification and DID-document construction as protocol/application functions; keep HTTP concerns in discovery adapters.
`packages/wot-core/src/services/GraphCacheService.ts` | `adapter-only` | Discovery/cache service behind ports | Useful offline graph cache orchestration. It should remain non-authoritative cache infrastructure over `DiscoveryAdapter` and `GraphCacheStore`.
`packages/wot-core/src/services/AttestationDeliveryService.ts` | `rewrite` | Application workflow over messaging/outbox ports | Delivery status tracking is useful, but attestation semantics and delivery workflow should live in application use cases, not a generic service bucket.
`packages/wot-core/src/services/EncryptedSyncService.ts` | `rewrite` | Protocol sync encryption plus crypto adapter | Implements AES-GCM CRDT-change encryption directly with Web Crypto and random nonce generation. Preserve the encrypt/decrypt flow, but move nonce construction and crypto operations behind `ProtocolCryptoAdapter` and spec Sync 001 rules.
`packages/wot-core/src/services/GroupKeyService.ts` | `rewrite` | Application sync key-management workflow | Generation handling mirrors Sync 005 concerns, including stale/future rotations, but the service owns random key generation and in-memory state. The pure generation disposition rule now lives in `packages/wot-core/src/protocol/sync/key-rotation-disposition.ts`; persistence, pending state, key import, and service migration remain future application/port work.
`packages/wot-core/src/services/VaultClient.ts` and `VaultPushScheduler.ts` | `adapter-only` | Vault HTTP adapter and scheduler | Useful vault integration, but concrete `fetch`, resource refs, capabilities, and scheduling must sit behind ports. Application composes them; CRDT adapters should not hard-import them.
`packages/wot-core/src/adapters/crypto/` | `adapter-only` | Adapter | `WebCryptoAdapter` is a concrete runtime adapter for non-protocol crypto ports. Keep out of protocol/application internals except through ports.
`packages/wot-core/src/adapters/storage/` | `adapter-only` | Adapter | LocalStorage, IndexedDB, in-memory, seed-vault, compact-store, and personal-doc metadata implementations are useful concrete adapters. They should not be root-exported as application defaults.
`packages/wot-core/src/adapters/messaging/` | `adapter-only` | Adapter | In-memory, WebSocket, outbox, traced wrappers, and personal-doc outbox stores are useful transport/outbox implementations. They must not define message validity beyond protocol envelope verification.
`packages/wot-core/src/adapters/discovery/` | `adapter-only` | Adapter | HTTP/offline discovery and memory stores are useful. `HttpDiscoveryAdapter` currently imports `ProfileService`, so profile protocol verification should be extracted before this is cleanly adapter-only.
`packages/wot-core/src/adapters/authorization/` | `adapter-only` | Adapter | In-memory authorization is useful for tests/demo composition only; protocol capability verification belongs in protocol/application.
`packages/wot-core/src/storage/CompactStorageManager.ts` | `adapter-only` | Storage adapter/infrastructure | Useful compaction persistence mechanism. Keep behind explicit storage/compact-store ports.
`packages/wot-core/src/storage/PersistenceMetrics.ts`, `TraceLog.ts`, traced wrappers | `remove` | Debug tooling only if explicitly kept | Useful during migration, but global debug APIs and tracing wrappers are not reference behavior. Keep temporarily as diagnostics, then remove or move to a debug-only adapter package.
`packages/wot-core/src/index.ts` root export | `remove` | Layered entry points | Flattens types, protocol, application, ports, services, adapters, storage, debug, and legacy crypto into one import surface. Replace with explicit entry points and delete compatibility exports after migration.
`packages/adapter-yjs/src/` | `adapter-only` | CRDT/docstore/replication adapter | Yjs personal doc, storage, sync, and replication are useful adapter mechanisms. Current code imports core services and exposes browser debug hooks/IndexedDB cleanup, so application sync authority must move out and browser details stay adapter-scoped.
`packages/adapter-automerge/src/` | `adapter-only` | CRDT/docstore/replication adapter | Automerge repo, personal doc, network, outbox, space metadata, compaction, and sync-only storage are useful adapter mechanisms. Current imports of `GroupKeyService`, `EncryptedSyncService`, `VaultClient`, `VaultPushScheduler`, and legacy crypto show authority leakage from application/services into adapters.
`apps/demo/src/runtime/appRuntime.ts` | `demo-only` | App composition root | Correct place for concrete runtime config and wiring. Keep composition decisions here; do not promote default URLs, Vite env behavior, or singleton workflow instances into reference core.
`apps/demo/src/context/AdapterContext.tsx` | `demo-only` | App composition plus React context | Mixes React state, identity-change cleanup, IndexedDB deletion, WebSocket connection policy, CRDT choice, migrations, service construction, and sync wiring. Preserve composition knowledge as an example; extract reusable application workflows and ports elsewhere.
`apps/demo/src/context/IdentityContext.tsx` and `PendingVerificationContext.tsx` | `demo-only` | React/app state | Useful UX state. Identity context currently mixes biometric/session concerns with app identity lifecycle and should consume application workflows only.
`apps/demo/src/hooks/` | `demo-only` | React layer | Hooks are valuable as future React-package candidates, but currently call adapters, services, protocol-shaped objects, and app contexts directly. Keep app-local until a second consumer justifies extraction.
`apps/demo/src/services/` | `rewrite` | Application or app adapters | Contact, verification, attestation, identity, biometric, barcode, and reset services mix application workflow, browser/native runtime APIs, storage adapters, and UI assumptions. Preserve only behavior that maps cleanly to application use cases or app-only runtime adapters.
`apps/demo/src/adapters/` | `adapter-only` | App-local adapters | Local Automerge/Yjs storage, cache, outbox, row mappers, and personal network adapters are useful migration examples. Keep behind ports only; app-local row/storage schemas are not reference protocol. Demo-specific wiring that is not useful behind a port should remain covered by the surrounding `demo-only` app rows.
`apps/demo/src/components/`, `pages/`, `i18n/`, `live-update.ts` | `demo-only` | App/UI | Product UI, QR rendering/scanning, native live updates, language state, D3 graph rendering, and browser behavior are not reference implementation boundaries.
`packages/wot-relay/src/` | `server-infra` | Sync broker infrastructure | WebSocket relay, challenge handling, offline queue, ACKs, and dashboard are reference-service candidates for Sync 003 only after envelope/capability checks are aligned with protocol modules.
`packages/wot-profiles/src/` | `server-infra` | Discovery/profile service infrastructure | SQLite profile store, HTTP server, dashboard, and profile JWS verification are service infrastructure for Sync 004. Replace local `jws-verify` authority with shared protocol verification.
`packages/wot-vault/src/` | `server-infra` | Vault infrastructure | Encrypted document store, capability auth, dashboard, and SQLite persistence are infrastructure. Keep capability verification aligned with protocol; remove vendored `wot-core-dist` once packages compose normally.
`packages/wot-vault/wot-core-dist/` | `remove` | Transitional build artifact | Vendored core dist is a compatibility artifact and should not be a source of reference behavior.
`packages/wot-cli/src/` | `server-infra` | Reference consumer / CLI infrastructure | Useful non-demo consumer for storage, server, and identity flows. Keep as a consumer of ports/adapters; do not let CLI storage choices define protocol semantics.
`apps/landing/`, `apps/benchmark/`, `packages/wot-fdroid/`, `deploy/` | `demo-only` | Product, benchmark, packaging, deployment | Useful project artifacts, but outside reference implementation boundaries.

## Mixed Boundary Findings

### Protocol Authority Mixed With Application Workflow

- `packages/wot-core/src/application/identity/identity-workflow.ts` creates identity sessions and signs JWS directly while also managing seed-vault lifecycle. Signing/JWS rules should remain in `protocol`; workflow should orchestrate seed recovery, storage, and session lifecycle through ports.
- `packages/wot-core/src/services/ProfileService.ts` verifies profile JWS, constructs public DID documents, and builds profile-service behavior in one module. DID/JWS verification and DID-document construction should be protocol/application functions; profile service transport and cache behavior should be adapters/server-infra.
- `packages/wot-core/src/services/GroupKeyService.ts` implements key generation, generation disposition, and in-memory state. The stale/future/application disposition is useful, but Sync 005 validation and key-rotation message semantics should be protocol/application-owned.
- `apps/demo/src/services/AttestationService.ts` and `VerificationService.ts` are app services that participate in trust workflows using storage and messaging directly. Preserve workflow intent only after mapping it to `application` use cases over ports.

### Application Workflow Mixed With Adapter Logic

- `packages/adapter-yjs/src/YjsReplicationAdapter.ts`, `YjsPersonalDocManager.ts`, and `YjsPersonalSyncAdapter.ts` import or instantiate sync services and core crypto helpers while also managing Yjs documents, browser persistence, vault refresh, and relay messaging.
- `packages/adapter-automerge/src/AutomergeReplicationAdapter.ts`, `PersonalDocManager.ts`, `PersonalNetworkAdapter.ts`, and `EncryptedMessagingNetworkAdapter.ts` import `GroupKeyService`, `EncryptedSyncService`, `VaultClient`, `VaultPushScheduler`, and legacy envelope crypto. These adapters should implement replication/docstore/network ports; application should compose sync policy, key policy, vault policy, and delivery policy.
- `apps/demo/src/context/AdapterContext.tsx` is both React provider and composition root. It decides CRDT implementation, performs destructive IndexedDB cleanup on identity change, opens WebSockets, migrates cache data, creates services, and wires replication. Keep as app composition, but do not treat it as reusable architecture.

### Adapter Logic Mixed With Browser Or Runtime Details

- `packages/wot-core/src/services/EncryptedSyncService.ts` uses global `crypto.subtle` and `crypto.getRandomValues` directly, so it is browser/runtime-bound despite living in shared core services.
- `packages/wot-core/src/services/VaultClient.ts`, `packages/wot-core/src/adapters/discovery/HttpDiscoveryAdapter.ts`, and `packages/wot-core/src/adapters/messaging/WebSocketMessagingAdapter.ts` use concrete HTTP/WebSocket runtime behavior in core. They are valid adapters only behind ports and explicit adapter entry points.
- `packages/wot-core/src/adapters/storage/LocalStorageAdapter.ts`, `SeedStorageIdentityVault.ts`, and `IndexedDBSpaceMetadataStorage.ts` use browser persistence in core. Keep as browser adapters, not application dependencies.
- `apps/demo/src/services/BarcodeScannerService.ts`, `BiometricService.ts`, `live-update.ts`, and reset flows are Capacitor/browser runtime integrations and must stay app-local or become runtime adapters.

### UI Assumptions Mixed With Workflow Semantics

- `apps/demo/src/hooks/useVerification.ts` and verification components combine QR UX state, peer display names, notifications/confetti, messaging, profile sync, and verification workflow calls.
- `apps/demo/src/hooks/useAttestations.ts`, `useContacts.ts`, `useGraphCache.ts`, and `useProfileSync.ts` couple React state and cache freshness to storage/discovery details.
- `apps/demo/src/pages/PublicProfile.tsx`, `Identity.tsx`, `Network.tsx`, and space pages derive URL, sharing, deletion, graph rendering, and profile assumptions from browser/UI state. Keep this as product UX, not reference application semantics.

### Server Infrastructure Mixed With Local Protocol Checks

- `packages/wot-relay/src/relay.ts` implements challenge-response registration, connection maps, queueing, ACKs, and dashboard behavior in one server class. The server is infrastructure; challenge and envelope verification should use shared protocol modules.
- `packages/wot-profiles/src/jws-verify.ts` duplicates JWS verification authority outside core protocol modules.
- `packages/wot-vault/src/auth.ts` verifies capabilities for document access. Keep the authorization policy server-side, but capability parsing and verification must align with shared protocol functions.

## Proven Mechanisms To Preserve As Ports Or Adapters

Mechanism | Preserve as | Replacement constraint
---|---|---
Protocol JCS/JWS/DID/key-derivation helpers | `protocol` reference-candidate | Must reproduce relevant conformance test vectors and import no app/adapters.
`WebCryptoProtocolCryptoAdapter` and `WebCryptoAdapter` | Crypto adapters | Runtime crypto behind ports; no direct application dependency on browser globals.
Seed vault and local encrypted identity storage | `IdentitySeedVault` adapter | Application workflow owns identity lifecycle; adapter owns persistence only.
WebSocket relay messaging and outbox retry | Messaging/outbox adapters | Message validity and ACK safety must be checked by protocol/application before adapter delivery status is trusted.
Offline discovery cache and publish state | Discovery/cache ports and adapters | Cache freshness cannot define trust/protocol validity.
Yjs and Automerge personal docs | Docstore/replication adapters | CRDT document mechanics are implementation detail; Sync ordering, capability, and key rules stay in protocol/application.
Group key generation and rotation disposition | Application sync workflow plus protocol validation | The protocol helper classifies stale/current, exactly-next, and future key-rotation generations. Future slices still need explicit, testable application handling for pending/durable state, key import, and recovery orchestration.
Vault HTTP document store and push scheduler | Vault adapter/server-infra | Application chooses when to push/pull; adapter performs HTTP and scheduling.
Relay, profile, and vault servers | `server-infra` | Servers exercise protocol behavior but do not become the source of normative rules.
Demo React hooks and contexts | Demo-only, possible future React package | Extract only after workflows and ports are stable and a second consumer needs them.

## Ambiguous Or Human-Decision Items

- Whether `packages/wot-core/src/crypto/capabilities.ts` and `envelope-auth.ts` should be migrated into `protocol/sync` or replaced by newer protocol modules needs an explicit compatibility decision.
- The reference boundary for `ProfileService` is unclear: profile JWS creation/verification may belong to application, while HTTP publication and discovery are adapters/server-infra.
- CRDT adapter responsibilities around key rotation, catch-up, vault refresh, and sync-request triggering need a precise port contract before replacing current Yjs/Automerge behavior.
- The demo identity-change cleanup deletes multiple IndexedDB databases. This may be correct app reset behavior, but it is not reference application behavior until specified as an explicit reset use case.
- `packages/wot-vault/wot-core-dist/` should be purged, but the replacement packaging path needs a separate build/deployment decision.

## Legacy-Purge Completion Criteria

The legacy boundary is complete only when these can become blocking tasks:

1. `packages/wot-core/src/protocol/` imports no `application`, `services`, `adapters`, React, browser storage, network, or UI modules, and relevant conformance test vectors pass against it.
2. `packages/wot-core/src/application/` orchestrates workflows only through `protocol`, `ports`, and pure domain types; no direct `window`, `document`, `indexedDB`, `localStorage`, `fetch`, `WebSocket`, or global Web Crypto calls remain.
3. Every concrete storage, crypto, messaging, discovery, replication, vault, CRDT, and runtime implementation is reachable through an explicit port or adapter entry point.
4. `packages/wot-core/src/services/` is empty, deleted, or split into named application workflows and adapter/server-infra modules with no mixed responsibility bucket.
5. Legacy duplicate crypto modules are removed or reduced to compatibility aliases with a dated deletion task; protocol crypto is the single authority for JCS/JWS/DID/capability/envelope rules.
6. Yjs and Automerge packages implement replication/docstore/network/storage ports without importing application services as required dependencies.
7. Demo hooks and contexts consume application workflows or view models; direct protocol generation/verification appears only in explicit debug or interop surfaces.
8. Relay, profile, and vault servers call shared protocol verification for envelopes, JWS, DID, and capabilities instead of local duplicate implementations.
9. `packages/wot-core/src/index.ts` no longer root-exports adapters, services, storage debug helpers, or legacy crypto as one flattened API.
10. Vendored or generated compatibility artifacts such as `packages/wot-vault/wot-core-dist/` are removed from source-controlled reference behavior.
11. Public compatibility decisions are explicit: each kept legacy API has a documented owner, migration path, and deletion or stabilization criterion.
12. Open protocol ambiguities found during migration are documented for a separate spec PR instead of being resolved by implementation behavior.
