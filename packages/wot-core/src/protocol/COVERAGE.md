# Protocol Core Coverage

This matrix tracks the TypeScript protocol-core coverage against the `wot-spec` conformance manifest and test vectors.

Legend:

- Full: implemented and checked by `packages/wot-core/tests/ProtocolInterop.test.ts`
- Partial: protocol pieces are covered, but the full profile behavior is not implemented in TS
- External: intentionally validated outside TS protocol-core
- Not covered: no TS protocol-core implementation yet
- Prose-backed coverage: no dedicated test vectors exist; behavior is implemented and tested against the normative prose of the cited spec sections

## Vector Coverage

| Profile | Vector file | Section | TS implementation | Test status | Notes |
|---|---|---|---|---|---|
| `wot-identity@0.1` | `phase-1-interop.json` | `identity` | `identity/key-derivation.ts`, `identity/did-key.ts` | Full | English BIP39 mnemonic to full 64-byte seed, Ed25519 seed/public key, X25519 seed/public key, DID, kid, multibase encodings. |
| `wot-identity@0.1` | `phase-1-interop.json` | `did_resolution` | `identity/did-key.ts`, `identity/did-document.ts`, `crypto/jcs.ts` | Full | Resolves bare did:key documents through the protocol DidResolver surface, returns null for unsupported methods, preserves bootstrap keyAgreement/service data, and the interop test recomputes the DID document JCS hash. |
| `wot-identity@0.1` | focused protocol tests | JWS/JCS mechanics from Identity 002 | `crypto/jcs.ts`, `crypto/jws.ts` | Full for slice | Sender-side JCS signing input, required non-empty `kid`, unsupported-alg rejection before crypto verification, exact received signing-input verification, tampered bytes, and unambiguous malformed compact JWS inputs. Spec-vector ownership remains tracked in `real-life-org/wot-spec#16`; JCS number edge vectors remain tracked in `real-life-org/wot-spec#17`. |
| `wot-trust@0.1` | `phase-1-interop.json` | `attestation_vc_jws` | `trust/attestation-vc-jws.ts`, `crypto/jcs.ts`, `crypto/jws.ts` | Full | Payload JCS hash, create, verify, VC context/type checks, issuer/subject checks, claim presence, deterministic `nbf`/`exp` checks, and extension-field tolerance. Delivery and `attestation-ack` semantics remain out of protocol-core scope and deferred to wot-spec issue #21. |
| `wot-trust@0.1` | `qr-challenge.schema.json` examples and Trust 002 behavior | `qr_challenge` | `trust/qr-challenge.ts` | Partial | Raw JSON QR challenge parsing, required fields, 32-byte `enc`, active challenge 5-minute window, and online nonce acceptance decisions. This follows `wot-spec` Trust 002 as the normative source; older in-repo protocol docs are legacy context, not conformance authority. Nonce-history storage and QR regeneration remain application responsibilities. |
| `wot-sync@0.1` | `phase-1-interop.json` | `didcomm_plaintext_envelope` | `sync/membership-messages.ts`, `sync/log-entry.ts` | Partial | Pure plaintext-envelope shape helpers reproduce the vector and log-entry transport body shape. External DIDComm library compatibility remains validated by `wot-spec` with `didcomm-node` and `@veramo/did-comm`. |
| `wot-sync@0.1` | `phase-1-interop.json` | `ecies` | `sync/encryption.ts`, `protocol-adapters/web-crypto.ts` | Full | Ephemeral public key, shared secret, HKDF AES key, encrypt vector, decrypt roundtrip, malformed input boundaries, tamper, and wrong-key rejection. |
| `wot-sync@0.1` | `phase-1-interop.json` | `log_payload_encryption` | `sync/encryption.ts` | Full | Deterministic nonce, AES-GCM ciphertext/tag, blob encoding, decrypt roundtrip, malformed input boundaries, tamper, and wrong-key rejection. |
| `wot-sync@0.1` | `phase-1-interop.json` | `log_entry_jws` | `sync/log-entry.ts` | Full | Create and verify JWS; authorKid binding, schema-backed payload shape checks, and envelope-authority boundary checks. |
| `wot-sync@0.1` | `phase-1-interop.json` | `log_entry_jws.payload.keyGeneration` plus Sync 002 blocked-by-key rule | `sync/log-entry-key-disposition.ts` | Full for slice | Focused coverage in `packages/wot-core/tests/LogEntryKeyDisposition.test.ts`: present non-negative safe-integer `keyGeneration` is `process-decrypt` only when that generation is locally available, otherwise `blocked-by-key`. Missing-field behavior is intentionally left to log-entry validation pending `real-life-org/wot-spec#25`. |
| `wot-sync@0.1` | focused protocol tests plus `phase-1-interop.json` | Sync 002 seq consistency, Sync 003 broker collision defense | `sync/seq-consistency.ts` | Full for slice | Classifies `brokerSeq > localSeq` as restore/clone required, treats `brokerSeq <= localSeq` as no restore/clone detected, validates seq as non-negative safe integers, and classifies opaque content-hash tokens for accept-new, idempotent retransmission, or `SEQ_COLLISION_DETECTED`. UUID-version validation remains out of this slice and tracked in `real-life-org/wot-spec#23`. |
| `wot-sync@0.1` | `phase-1-interop.json` | `space_capability_jws` | `sync/space-capability.ts` | Full | Create and verify JWS; key, audience, space, generation, expiry checks, and capability payload schema invariants from `capability-payload.schema.json`. |
| `wot-sync@0.1` | `phase-1-interop.json` | `space_membership_messages.space_invite_body`, `member_update_body`, `key_rotation_body` | `sync/membership-messages.ts` | Full for message shape | Pure WoT Plaintext Envelope parsing and schema-shaped body validation for `space-invite/1.0`, `member-update/1.0`, and `key-rotation/1.0`; rejects legacy `group-key-rotation` as a normative type. Capability JWS payload correlation is deferred to `real-life-org/wot-spec#24`. |
| `wot-sync@0.1` | focused protocol tests | Sync 002 Inbox-Verarbeitung und ACK / Sync 003 `ack/1.0` | `sync/inbox-ack-disposition.ts` | Full for slice | Pure client-side ACK disposition only: ACK after durable apply, durable pending buffer with dependency metadata, conclusive invalid rejection without authoritative state change, and replay-history duplicates. No ACK for volatile pending or incomplete decryption, verification, replay, apply, or buffer work. ACK is documented as per-device transport/persistence confirmation only, not semantic acceptance or `attestation-ack`. |
| `wot-sync@0.1` | `phase-1-interop.json` | `space_membership_messages.member_update_generation_cases` | `sync/member-update-disposition.ts` | Full | Evaluates signer authority, idempotency, authority upgrade/no-downgrade, stale/current/next generation, and future generation disposition vectors. |
| `wot-sync@0.1` | `phase-1-interop.json` | `space_membership_messages.key_rotation_body.generation` | `sync/key-rotation-disposition.ts` | Full for slice | Pure generation disposition only: `local+1` applies, `<=local` ignores as stale/duplicate, `>local+1` buffers as future. Key import, durable buffering, catch-up orchestration, and capability verification remain outside this protocol helper. |
| `wot-sync@0.1` | focused protocol tests | Sync 003 broker error responses | `sync/broker-error.ts` | Partial | Broker error-code catalog, error-body shape with known `code` and human-readable `message`, unknown-code rejection, extra-field tolerance, and explicit client-action mappings for `SEQ_COLLISION_DETECTED` and `CAPABILITY_EXPIRED`. Full error-envelope parsing is intentionally out of scope pending clarification in `real-life-org/wot-spec#36`. |
| `wot-sync@0.1` | focused protocol tests | Sync 003 heads semantics and Sync 002 multi-source heads comparison | `sync/heads.ts` | Prose-backed coverage | No dedicated heads test vectors exist in `phase-1-interop.json`; `SyncHeads.test.ts` expresses missing-head `seq=0`, known-head `N+1`, truncated response continuation, and identical/different heads comparison from Sync 002/003 prose. |
| `wot-sync@0.1` | `phase-1-interop.json` | `admin_key_derivation` | `sync/admin-key.ts` | Full | HKDF info with canonical lowercase UUID, 64-byte BIP39 seed validation, UUID v4 validation, Ed25519 seed/public key, and admin DID. |
| `wot-sync@0.1` | `phase-1-interop.json` | `personal_doc` | `sync/personal-doc.ts` | Full | 64-byte BIP39 seed validation, Personal Doc key, exact 32-byte Personal Doc key requirement, and deterministic document ID. |
| `wot-sync@0.1` | `profile-service-response.schema.json`, Sync 004 prose, and focused protocol tests | Sync 004 `/p/{did}` profile-service profile resource | `sync/profile-service-resource.ts` | Partial | Covers pure payload validation for required known fields, DID/path and DID-document consistency, safe integer version boundaries, RFC3339 `updatedAt`, profile metadata key-material rejection, deterministic server PUT version decisions, client rollback detection, and generic Identity 002 compact EdDSA JWS verification over the exact received signing input. Profile-service resource-specific JWS `typ`, `/p/{did}/v` and `/p/{did}/a` list-resource schemas, top-level/profile-object additional-property/key-material ownership, and vector ownership remain deferred to `real-life-org/wot-spec#34`. |
| `wot-sync@0.1` | Sync 004 Discovery / recovery fallback | `profile_service_recovery_scope` | `sync/profile-recovery-scope.ts` | Partial | Focused coverage for the closed recovery-boundary decision in `real-life-org/wot-spec#19`: profile-service fallback may classify only public signed discovery artifacts as recoverable, must forbid private wallet/Personal Doc/Vault/space/private Sync state, must treat unknown artifacts as out of scope, and must expose the mandatory JWS signature, DID/path consistency, and version monotonicity gates. Profile-service HTTP behavior, cache fallback, persistence, profile merge, contact import, Personal Doc restore, Vault restore, CRDT restore, and application recovery orchestration remain out of protocol-core scope. |
| `wot-hmc@0.1` | `phase-1-interop.json` | `sd_jwt_vc_trust_list` | `trust/sd-jwt-vc.ts` | Partial | Generic SD-JWT VC vector mechanics are covered today: disclosure encoding, digest, compact construction, issuer JWS verification, and digest-presence verification. `packages/wot-core/tests/HmcTrustList.test.ts` covers the HMC H01 Trust List verifier MUST surface: caller-supplied `vct`, `_sd_alg=sha-256`, required/non-expired `exp`, and required/non-future `iat` after generic verification. The production HMC `vct` remains pending in real-life-org/wot-spec#37. |
| `wot-device-delegation@0.1` | `device-delegation.json` | `device_key_binding_jws` | `identity/device-key-binding.ts` | Full | Create, verify, public key binding, issuer checks. |
| `wot-device-delegation@0.1` | `device-delegation.json` | `delegated_attestation_bundle` | `trust/delegated-attestation-bundle.ts` | Full | Create and verify bundle; identity issuer and device signer relationship. |
| `wot-device-delegation@0.1` | `device-delegation.json` | `invalid_cases` | `trust/delegated-attestation-bundle.ts` | Full | Rejects expired delegation, missing capability, and kid mismatch vectors. |

## Schema Coverage

JSON Schema validation generally remains owned by `wot-spec`:

```bash
npm run validate:schemas
```

The TypeScript protocol-core validates protocol behavior against vectors and now mirrors focused Sync 002/003 schema constraints for log-entry payloads, plaintext-envelope shapes, and the `space_capability_jws` capability payload invariants needed before signing and after JWS decoding. Complete schema-suite validation remains centralized in `wot-spec`.

## Current Gaps

- Complete SD-JWT VC implementation beyond the current trust-list vector requirements, including holder binding / `cnf` verification.
- HMC trust-score path aggregation, hop-limit propagation, minimum-score policy, and anti-gaming rules; these remain deferred to real-life-org/wot-spec#9.
- HMC Gossip (H03), Payment (H02), Sent-Log behavior, piggybacking, Sync inbox forwarding, RLS display fields, and application workflow behavior.
- JSON Schema validation in TS; currently intentionally centralized in `wot-spec`.
- Spec-owned standalone JWS/AES vector ownership and JCS number edge-case coverage are deferred to `real-life-org/wot-spec#16` and `real-life-org/wot-spec#17`.
- Log-entry `deviceId`/`docId` UUID version-specific enforcement is deferred pending `wot-spec` issue #23; TS currently mirrors the generic schema `uuid` boundary. `sync/seq-consistency.ts` intentionally validates only seq values and opaque content-hash tokens.
- Sync 004 profile-service resource-specific JWS `typ`, `/p/{did}/v` and `/p/{did}/a` list-resource schemas, top-level/profile-object additional-property/key-material ownership, and vector ownership are deferred pending `real-life-org/wot-spec#34`.
- [NEEDS CLARIFICATION: Sync 003 error response envelope shape; `real-life-org/wot-spec#36`] Sync 003 defines an `error/1.0` example, but protocol-core currently covers only the isolated broker error catalog and body classification. Full error-envelope conformance remains out of scope until the envelope shape is clarified.

## External Boundaries

- DIDComm plaintext-envelope library compatibility is a transport boundary. TypeScript exposes pure shape helpers for the Sync 003 plaintext envelope, while DIDComm parser compatibility remains validated in `wot-spec` against DIDComm libraries.
