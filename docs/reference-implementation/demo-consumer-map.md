# Demo Consumer Map

This document maps the current demo app to the target reference implementation boundaries. It is inventory and migration planning only; it does not change runtime behavior.

## Sources

Spec references below are repo-root path references, sometimes with Markdown anchors, following `docs/PROJECT-FLOW.md`; they intentionally use `../wot-spec/...` rather than file-relative Markdown links from this document.

- Spec map: `../wot-spec/README.md#spec-landkarte`
- Conformance profiles: `../wot-spec/CONFORMANCE.md` and `../wot-spec/conformance/manifest.json`
- TypeScript target map: `../wot-spec/ARCHITECTURE.md` and `../wot-spec/IMPLEMENTATION-ARCHITECTURE.md`
- Current local refactor note: [`docs/reference-implementation-refactor.md`](../reference-implementation-refactor.md)
- Demo inventory: `apps/demo/src/runtime/appRuntime.ts`, `apps/demo/src/context/AdapterContext.tsx`, `apps/demo/src/hooks/*`, `apps/demo/src/services/*`, and `apps/demo/src/adapters/*`

## Target Consumer Shape

The demo should become a reference consumer of the implementation layers, not a second protocol implementation.

```txt
apps/demo
  runtime composition root
    concrete browser, mobile, relay, vault, discovery, CRDT, and cache adapters
  React-facing hooks and contexts
    call application workflows and view-model services
  pages and components
    render product flows and route user intent

@web_of_trust/core/application
  identity, verification, attestation, spaces, sync recovery workflows

@web_of_trust/core/ports
  storage, discovery, messaging, outbox, replication, member-key lookup,
  identity vault, crypto, cache, publish-state, clock/random as needed

@web_of_trust/core/protocol
  deterministic Identity, Trust, and Sync objects, encodings, and verification

adapter packages or adapter entry points
  browser crypto/storage/network, profile HTTP, relay WebSocket,
  Yjs/Automerge doc stores and replication, local cache/outbox
```

The app composition root may import concrete adapters. React hooks, services, and UI should consume application workflows or port-shaped view models. Direct protocol imports in React code should remain limited to explicit technical debug or interop surfaces.

## Flow Map

| Demo flow | User-facing use-case | Spec profile | Target application use-case | Ports and adapter capabilities |
|---|---|---|---|---|
| Identity creation | New user creates recovery words, local password/session protection, DID, and first profile. | `wot-identity@0.1` | `IdentityWorkflow.createIdentity` plus app onboarding profile handoff. | Identity vault for seed/session storage, protocol crypto adapter, local profile storage, discovery publish capability after app storage is ready. |
| Identity unlock | Returning user unlocks stored identity or active session. | `wot-identity@0.1` | `IdentityWorkflow.hasStoredIdentity`, `hasActiveSession`, `unlockStoredIdentity`. | Identity vault, optional platform biometric/passkey wrapper, local storage access checks. |
| Identity recovery | User imports recovery words and rebuilds local identity, then restores published profile/trust data where available. | `wot-identity@0.1`, discovery parts of `wot-sync@0.1` | Identity recovery workflow plus a separate sync/discovery recovery use-case. | Identity vault, discovery resolution, local storage save, profile/verifications/attestations restore, outbox/discovery retry. |
| In-person verification | User shows QR challenge, peer scans, confirms, sends verification, and both users see mutual verification state. | `wot-trust@0.1` | Verification challenge/response workflow, incoming verification confirmation, counter-verification. | Verification store, messaging/outbox send, discovery/profile sync, nonce history or active challenge state, contact storage. |
| Attestation creation and receipt | User issues a signed claim to a contact; recipient validates, stores, accepts/publishes, and sender tracks delivery. | `wot-trust@0.1` | Attestation workflow plus delivery-status use-case. | Attestation store, messaging/outbox, receipt/ack listener, discovery publish for accepted attestations, delivery-status persistence. |
| Space creation | User creates an encrypted shared space. | `wot-sync@0.1` | Spaces workflow over a replication port. | Replication adapter, group/content key management, durable local doc/log storage, metadata storage, messaging transport, vault push/pull if enabled. |
| Space invite | User invites verified contacts and invitee receives a space notification with usable encrypted state. | `wot-sync@0.1` | `SpacesWorkflow.inviteMember` plus invite notification view model. | Member encryption-key resolution, replication `addMember`, `space-invite` send/receive, member-update handling, sync catch-up trigger, profile/contact cache for display names. |
| Member removal and key rotation | Space admin removes a member; remaining members continue and removed member cannot decrypt new content. | `wot-sync@0.1` | `SpacesWorkflow.removeMember` plus sync/key-rotation recovery behavior. | Replication `removeMember`, key rotation generation handling, durable pending storage for future rotations, member-update and key-rotation messaging, sync catch-up. |
| Sync recovery | App starts, reconnects, changes identity/device, or receives remote personal-doc/space updates and converges without losing accepted log entries. | `wot-sync@0.1` | Sync recovery/orchestration use-case separate from CRDT adapter choice. | Load local state first, relay auth, outbox flush, personal doc sync before spaces, space `sync-request`, blocked-by-key queue, durable pending inbox, discovery retry, vault refresh where configured. |

## Minimum Demo Flows Before Legacy Purge

The legacy purge should not remove old services or adapter paths until these flows are covered by the new reference boundaries:

1. Identity creation: create seed, derive DID/session, persist seed, store initial profile, and publish profile when discovery is available.
2. Identity recovery: import recovery words, persist recovered seed, restore profile/verifications/accepted attestations from discovery if present, and tolerate offline recovery with an empty local profile.
3. Verification: create QR challenge, reject self-verification, create/send verification, save incoming verification, support counter-verification, update contact state, and publish received verifications.
4. Attestations: create signed attestation, send or queue it, receive and verify incoming attestations, accept/reject locally, publish only accepted received attestations, and preserve delivery/ack status.
5. Space invite: create shared space, resolve invitee encryption key through a port, send/process invite, notify invitee, open the invited space, and trigger catch-up.
6. Member removal/key rotation: remove member, rotate keys, notify remaining members, apply exactly-next rotations, durably buffer future rotations, ignore stale rotations, and recover missing keys through sync/inbox/personal-doc paths.
7. Sync recovery as applicable to demo mode: app start and reconnect load local data first, authenticate relay, sync personal doc before spaces, flush outbox, retry discovery, catch up spaces, and preserve valid local log entries.

If a flow is intentionally out of scope for the demo, record that as a conscious decision before deleting the corresponding legacy surface.

## Import Debt Inventory

These imports are acceptable only at the composition root or in adapter shims. They should disappear from demo-facing hooks, contexts, pages, and app services as reference workflows/ports become available.

| Current location | Direct import or dependency | Why it is debt | Target owner |
|---|---|---|---|
| `apps/demo/src/runtime/appRuntime.ts` | `@web_of_trust/core/adapters`, `@web_of_trust/core/protocol-adapters` | Concrete adapters belong here now, but should move to explicit adapter entry points instead of the mixed core adapter namespace. | Composition root with explicit adapter packages/entry points. |
| `apps/demo/src/context/AdapterContext.tsx` | `WebCryptoAdapter`, `WebSocketMessagingAdapter`, `HttpDiscoveryAdapter`, `OfflineFirstDiscoveryAdapter`, `OutboxMessagingAdapter`, `PersonalDocSpaceMetadataStorage` from `@web_of_trust/core/adapters` | This file is a composition root today, but it also owns recovery, migration, sync orchestration, and service construction. | Split into runtime composition plus application sync/discovery use-cases. |
| `apps/demo/src/context/AdapterContext.tsx` | `CompactStorageManager`, `getMetrics` from `@web_of_trust/core/storage` | Browser/local infrastructure and telemetry are wired inside React provider logic. | Adapter/runtime infrastructure ports. |
| `apps/demo/src/components/debug/DebugPanel.tsx` | `DebugSnapshot` from `@web_of_trust/core/storage` | Demo-facing debug UI imports a storage snapshot type directly. This is acceptable only as an explicit debug surface, not as product workflow dependency. | Debug view-model/type entry point or debug-only adapter surface. |
| `apps/demo/src/context/AdapterContext.tsx` | `GroupKeyService` from `@web_of_trust/core/services` | Core service is composed directly into CRDT adapters, making the adapter/application boundary unclear. | Application sync/spaces composition against key-management ports. |
| `apps/demo/src/context/AdapterContext.tsx` | Dynamic imports from `@web_of_trust/adapter-yjs` and `@web_of_trust/adapter-automerge` | Runtime selection is legitimate, but it is mixed with React provider state and recovery behavior. | Composition root factory returning port implementations. |
| `apps/demo/src/hooks/useSpaces.ts` | `@web_of_trust/core/protocol` for `x25519MultibaseToPublicKeyBytes` | React hook performs protocol decoding for member-key lookup. | `SpaceMemberKeyDirectory` adapter/use-case supplied by composition root or application layer. |
| `apps/demo/src/hooks/useGraphCache.ts` | `GraphCacheService` from `@web_of_trust/core/services` | Hook imports a core service directly instead of a workflow/view model. | Discovery/graph application use-case or cache port. |
| `apps/demo/src/services/AttestationService.ts` | `signEnvelope` from `@web_of_trust/core/crypto` and `createResourceRef` from `@web_of_trust/core/types` | App-local service signs transport envelopes and builds resource references. | Attestation delivery application use-case using messaging/outbox ports. |
| `apps/demo/src/services/AttestationService.ts` | `createAttestationWorkflow` from runtime | App service constructs workflow indirectly and owns delivery state. | Application attestation use-case plus delivery-status port/view model. |
| `apps/demo/src/hooks/useVerification.ts` | `verificationWorkflow` via `../services/verificationWorkflow` | Hook calls a singleton workflow and manually builds relay envelopes. | Verification application use-case that receives storage/messaging/discovery ports. |
| `apps/demo/src/services/resetLocalAppData.ts`, `apps/demo/src/pages/Identity.tsx` | Dynamic CRDT database deletion imports | UI/service code knows concrete CRDT persistence. | Runtime reset adapter or storage-management port. |
| `apps/demo/src/adapters/*` and `apps/demo/src/personalDocManager.ts` | Re-exports from Automerge/Yjs packages | Mostly adapter shims; acceptable only while app-local adapter paths exist. | Remove when composition imports canonical adapter packages directly. |

## Adapter Capability Requirements

The demo needs adapter capabilities, not a normative CRDT implementation. Yjs and Automerge are interchangeable implementation choices only if they satisfy the same ports and conformance-relevant behavior.

Required capabilities:

- Identity vault: persist/retrieve/delete seed material, track active session if supported, and fail clearly when storage is unavailable.
- Protocol crypto: derive keys, sign, verify, encrypt/decrypt as required by `wot-identity@0.1`, `wot-trust@0.1`, and `wot-sync@0.1`.
- Storage and reactive storage: identity profile, contacts, verifications, attestations, metadata, delivery statuses, and subscriptions for UI updates.
- Messaging and outbox: authenticated relay connection, signed envelope send, receipt handling, offline queueing, retry/flush, safe ignore for unknown message types.
- Discovery/profile: resolve profiles, DID documents/key agreement, public verifications, public attestations; publish profile/verifications/accepted attestations with dirty-state retry.
- Graph/profile cache: cache contact profile/trust data for offline display and member-key lookup assistance without becoming protocol authority.
- Replication: create/open/list/watch spaces, transact docs, add/remove/leave members, request sync, expose key generation for diagnostics, and preserve local-first durability.
- Member-key directory: resolve a member encryption public key from DID documents or cached QR/profile material and return a missing-key error instead of inventing a key.
- Key management: create/import group keys, apply rotations by generation, keep durable pending rotations or blocked entries, and recover missing keys.
- Metadata and compact/persistent stores: store space metadata, compact snapshots or local doc state as adapter optimizations, and never replace required log catch-up semantics.
- Sync recovery orchestration: local load, relay auth, personal-doc-first sync, space catch-up, blocked-by-key retry, outbox flush, discovery retry, and vault refresh when configured.

Non-goals for this document:

- Selecting Yjs or Automerge as normative.
- Rewriting demo code.
- Changing `wot-spec` semantics.
- Preserving legacy APIs unless a later migration slice records them as a conscious compatibility decision.

## Open Questions

These need human/spec decisions or a separate spec PR before runtime behavior is invented locally:

- [LEGACY MIGRATION: normalize space key-rotation message naming before protocol parsing] Sync 005 now names `key-rotation` as the only normative known Inbox message type for Space-Key-Rotation, and the protocol membership parser rejects `group-key-rotation`. Demo or adapter-local migration aliases must normalize legacy `group-key-rotation` before handing messages to protocol code.
- [NEEDS CLARIFICATION: split invite/member-update validation authority] The current invite/member-update handling sometimes uses local envelope payload shapes and adapter-local authorization checks. The split between protocol validation, application signer policy, and adapter delivery mechanics should be made explicit before moving logic out of CRDT adapters.
- [NEEDS CLARIFICATION: define discovery recovery guarantees] Recovery currently restores profile, verifications, attestations, and contacts from the profile service. The minimum normative discovery recovery guarantees versus demo convenience restore behavior should be clarified.
- [NEEDS CLARIFICATION: classify delivery receipts and attestation ack] Delivery receipts and `attestation-ack` are app behavior today. Confirm whether any part belongs to a future conformance profile or remains a demo/reference application feature.
