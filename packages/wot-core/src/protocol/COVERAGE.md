# Protocol Core Coverage

This matrix tracks the TypeScript protocol-core coverage against the `wot-spec` conformance manifest and test vectors.

Legend:

- Full: implemented and checked by `packages/wot-core/tests/ProtocolInterop.test.ts`
- Partial: protocol pieces are covered, but the full profile behavior is not implemented in TS
- External: intentionally validated outside TS protocol-core
- Not covered: no TS protocol-core implementation yet

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
| `wot-sync@0.1` | `phase-1-interop.json` | `space_capability_jws` | `sync/space-capability.ts` | Full | Create and verify JWS; key, audience, space, generation, expiry checks. |
| `wot-sync@0.1` | `phase-1-interop.json` | `space_membership_messages.member_update_generation_cases` | `sync/member-update-disposition.ts` | Full | Evaluates signer authority, idempotency, authority upgrade/no-downgrade, stale/current/next generation, and future generation disposition vectors. |
| `wot-sync@0.1` | `phase-1-interop.json` | `admin_key_derivation` | `sync/admin-key.ts` | Full | HKDF info, Ed25519 seed/public key, admin DID. |
| `wot-sync@0.1` | `phase-1-interop.json` | `personal_doc` | `sync/personal-doc.ts` | Full | Personal Doc key and deterministic document ID. |
| `wot-hmc@0.1` | `phase-1-interop.json` | `sd_jwt_vc_trust_list` | `trust/sd-jwt-vc.ts` | Partial | Generic SD-JWT VC vector mechanics are covered today: disclosure encoding, digest, compact construction, issuer JWS verification, and digest-presence verification. `packages/wot-core/tests/HmcTrustList.test.ts` covers the HMC H01 Trust List verifier MUST surface: caller-supplied `vct`, `_sd_alg=sha-256`, required/non-expired `exp`, and required/non-future `iat` after generic verification. The production HMC `vct` remains pending in real-life-org/wot-spec#37. |
| `wot-device-delegation@0.1` | `device-delegation.json` | `device_key_binding_jws` | `identity/device-key-binding.ts` | Full | Create, verify, public key binding, issuer checks. |
| `wot-device-delegation@0.1` | `device-delegation.json` | `delegated_attestation_bundle` | `trust/delegated-attestation-bundle.ts` | Full | Create and verify bundle; identity issuer and device signer relationship. |
| `wot-device-delegation@0.1` | `device-delegation.json` | `invalid_cases` | `trust/delegated-attestation-bundle.ts` | Full | Rejects expired delegation, missing capability, and kid mismatch vectors. |

## Schema Coverage

Full JSON Schema validation remains owned by `wot-spec`:

```bash
npm run validate:schemas
```

The TypeScript protocol-core validates protocol behavior against vectors and now mirrors focused Sync 002/003 schema constraints for log-entry payloads and plaintext-envelope shapes. Complete schema-suite validation remains centralized in `wot-spec`.

## Current Gaps

- Complete SD-JWT VC implementation beyond the current trust-list vector requirements, including holder binding / `cnf` verification.
- HMC trust-score path aggregation, hop-limit propagation, minimum-score policy, and anti-gaming rules; these remain deferred to real-life-org/wot-spec#9.
- HMC Gossip (H03), Payment (H02), Sent-Log behavior, piggybacking, Sync inbox forwarding, RLS display fields, and application workflow behavior.
- JSON Schema validation in TS; currently intentionally centralized in `wot-spec`.
- Spec-owned standalone JWS/AES vector ownership and JCS number edge-case coverage are deferred to `real-life-org/wot-spec#16` and `real-life-org/wot-spec#17`.
- Log-entry `deviceId`/`docId` UUID version-specific enforcement is deferred pending `wot-spec` issue #23; TS currently mirrors the generic schema `uuid` boundary.

## External Boundaries

- DIDComm plaintext-envelope library compatibility is a transport boundary. TypeScript exposes pure shape helpers for the Sync 003 plaintext envelope, while DIDComm parser compatibility remains validated in `wot-spec` against DIDComm libraries.
