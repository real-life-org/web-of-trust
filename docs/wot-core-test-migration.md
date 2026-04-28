# WoT Core Test Migration Inventory

This inventory classifies the current `packages/wot-core/tests` suite for the reference implementation refactor. It is a planning aid only; tests should move when their target slice is implemented.

## Classification

| Test file | Current subject | Classification | Migration target | Behaviors to preserve | Caveats |
| --- | --- | --- | --- | --- | --- |
| `ProtocolInterop.test.ts` | Protocol vectors for DID/key derivation, JWS, ECIES, SD-JWT, sync, and delegation | protocol | Protocol conformance/vector suite | Exact vector reproduction, JCS hashes, invalid delegated bundle rejection | High-value reference baseline |
| `WotIdentity.test.ts` | Legacy identity facade lifecycle, signing, JWS, deterministic DID | application | Identity application use-case tests | Mnemonic creation, deterministic unlock, DID format, storage lock/delete, signing/JWS verify | Split away from legacy `WotIdentity` during the Identity slice |
| `CryptoAdapterExtended.test.ts` | WebCrypto HKDF, Ed25519 seed derivation, X25519/ECIES | adapter | Crypto adapter contract tests | Deterministic derivation, 32-byte keys, wrong-key failures, random bytes | WebCrypto-specific expectations |
| `AsymmetricCrypto.test.ts` | Identity-level X25519 encryption helpers | application | Identity encryption use-case tests | Deterministic encryption keypair, distinct signing/encryption keys, ephemeral ciphertexts, tamper rejection | Depends on legacy `WotIdentity`; migrate after identity key material API stabilizes |
| `CompactStorageManager.test.ts` | IndexedDB binary compact storage | adapter | Storage adapter contract tests | Binary roundtrip, overwrite latest-wins, list/delete, empty and large binary payloads | Isolate IndexedDB database names |
| `VaultPushScheduler.test.ts` | Debounced push scheduler and dirty-head checks | application | Sync application service tests | Debounce reset, dirty checks, in-flight dedupe, flush/destroy behavior | Timer-heavy; keep fake timer determinism |
| `EnvelopeAuth.test.ts` | Message envelope canonical signing and verification | protocol | Messaging protocol/auth tests | Canonical signing input, critical signed fields, tamper and wrong-signer rejection | Current canonical format may become protocol-locked |
| `Capabilities.test.ts` | Capability JWS creation, verification, and delegation | protocol | Capability protocol tests | Permission sorting, unique IDs, expiry, attenuation, chain validation | Replace `WotIdentity.signJws` with protocol signer fixtures |
| `MessagingAdapter.test.ts` | In-memory messaging relay adapter | adapter | Messaging adapter contract tests | Connection states, send receipts, offline queue, callbacks, reset isolation | Some in-memory behavior may not apply to real transports |
| `OutboxMessagingAdapter.test.ts` | Offline outbox wrapper for messaging | adapter | Messaging/outbox adapter tests | Queue on disconnect/failure, deduplication, FIFO flush, retry count, auto-flush | Wrapper semantics cross adapter/application boundary |
| `GraphCacheService.test.ts` | Discovery graph cache service and in-memory cache store | application | Graph cache service tests plus cache store adapter tests | Cache fallback, stale/background refresh, concurrency, summaries, search, overwrite rules | Mixed service/store coverage; split later |
| `OfflineFirstDiscoveryAdapter.test.ts` | Offline-first discovery wrapper | adapter | Discovery adapter wrapper tests | Dirty flags, cache fallback, delegated summaries, partial pending sync success | Adapter naming hides sync policy decisions |
| `VerificationStorage.test.ts` | Verification persistence through `LocalStorageAdapter` | adapter | Verification storage adapter tests | Same-direction overwrite, opposite direction preserved, unreciprocated incoming detection | Extract filtering logic if it is product behavior |
| `VerificationIntegration.test.ts` | Challenge/response verification with identities | application | Verification application use-case tests | Challenge preservation, nonce mismatch rejection, proof shape, signature verify, bidirectional verification | Split by challenge, completion, and verification creation |
| `VerificationRelay.test.ts` | Relay-assisted verification plus profile avatar JWS flow | e2e | Core integration/e2e smoke tests | Full relay flow, offline recipient queue, valid signatures, avatar preservation | Combines verification relay and profile coverage |
| `GroupKeyService.test.ts` | Group key lifecycle | application | Space/group-key application service tests | 32-byte keys, generation tracking, rotation, multi-space isolation | Persistence not covered |
| `EncryptedSyncService.test.ts` | Encrypted sync change payloads | application | Sync encryption service tests | AES-GCM metadata, wrong-key behavior, random nonces, tamper failure | Could move to protocol if wire format is standardized |
| `ProfileService.test.ts` | Signed public profile JWS | application | Profile application service tests | JWS roundtrip, tamper rejection, DID/signature mismatch rejection, Unicode fields | Identity-adjacent; migrate after signing API stabilizes |
| `SymmetricCrypto.test.ts` | WebCrypto AES-GCM symmetric crypto | adapter | Crypto adapter contract tests | 32-byte keys, random 12-byte nonces, wrong key/nonce/tamper failures | Adapter-level, not domain-specific |
| `ResourceRef.test.ts` | `wot:` resource reference format | protocol | Resource-ref protocol/type tests | Creation/parsing, DIDs with colons, subpaths, resource types, validation errors | Small stable protocol primitive |
| `OnboardingFlow.test.ts` | User onboarding sequence around mnemonic/passphrase | react | React/onboarding flow tests plus identity use cases | Generate mnemonic/DID, random identities, BIP39 word shape, mnemonic verification, final stored identity | Move after identity application API stabilizes |
| `SeedStorage.test.ts` | Encrypted seed storage | adapter | Identity storage/seed-vault adapter tests | PBKDF2 plus AES-GCM behavior, wrong passphrase error, null when absent, idempotent delete | Browser storage/global crypto assumptions |

## Identity Slice Priority

Status: the first Identity slice now has a framework-free `IdentityWorkflow`, an `IdentitySession` method interface, a seed-vault port, and demo onboarding/recovery/unlock wiring. The remaining identity-adjacent tests below are still useful for later hardening and cleanup.

1. `WotIdentity.test.ts` is the primary legacy behavior map for create, recover, unlock, sign, lock, and delete identity use cases.
2. `SeedStorage.test.ts` should become the seed-vault adapter contract before persisted unlock behavior is trusted.
3. `CryptoAdapterExtended.test.ts` protects deterministic derivation and HKDF/X25519 foundations.
4. `AsymmetricCrypto.test.ts` should follow once the identity key material API is stable.
5. `ProfileService.test.ts` is identity-adjacent and should move after signing is stable.
6. `OnboardingFlow.test.ts` should migrate last into React/UI-flow coverage after core identity use cases exist.

## Verification Slice Status

The first verification slice now has a framework-free `VerificationWorkflow` and a new `VerificationWorkflow.test.ts` suite covering challenge creation, self-verification rejection, challenge responses, response completion, counter-verifications, signature verification, and DID public-key extraction.

The legacy `VerificationHelper` still exists for compatibility and delegates to `VerificationWorkflow`. Demo verification code uses the new workflow directly through `apps/demo/src/services/verificationWorkflow.ts`.

## Attestation Slice Status

The first attestation slice now has a framework-free `AttestationWorkflow` and a new `AttestationWorkflow.test.ts` suite covering VC-JWS creation, legacy field signatures, tamper rejection, export/import, and incomplete import rejection.

The demo `AttestationService` now creates and verifies attestations through `AttestationWorkflow`. Delivery tracking remains in the demo service because it is an app-level messaging concern.
