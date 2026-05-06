# Reference Implementation Conformance Inventory: `wot-identity@0.1`

**Status:** Living conformance tracker — initial inventory plus protocol DID resolver, JWS/JCS, and BIP39 seed implementation-slice updates.
**Last updated:** 2026-05-06.
**Scope:** Maps the `wot-identity@0.1` profile from `../wot-spec/CONFORMANCE.md` (manifest entry `profiles["wot-identity@0.1"]`) to the current TypeScript reference implementation in `packages/wot-core/`.

The profile sources (per `../wot-spec/conformance/manifest.json`):

- `../wot-spec/01-wot-identity/001-identitaet-und-schluesselableitung.md`
- `../wot-spec/01-wot-identity/002-signaturen-und-verifikation.md`
- `../wot-spec/01-wot-identity/003-did-resolution.md`
- `../wot-spec/schemas/did-document-wot.schema.json`
- `../wot-spec/test-vectors/phase-1-interop.json`, sections `identity` and `did_resolution`

This inventory was produced from `../wot-spec/CONFORMANCE.md`, the three `../wot-spec/01-wot-identity/` documents, `../wot-spec/schemas/did-document-wot.schema.json`, `../wot-spec/conformance/manifest.json`, the vendored phase-1 test vector at `packages/wot-core/tests/fixtures/wot-spec/phase-1-interop.json`, and the current `packages/wot-core` implementation. The slice does not edit `../wot-spec`; ambiguities and implementation follow-ups are recorded below.

Disposition legend:

- **Reusable:** existing implementation appears to satisfy the requirement (verified against phase-1 vectors where applicable).
- **Needs rewrite:** an implementation exists, but does not match the protocol-aligned shape. The new path should be the canonical one; the legacy artifact should be migrated or deleted in a later slice.
- **Missing:** no implementation found.
- **External by design:** intentionally not in TS protocol-core (e.g., DIDComm framing).

Checklist semantics: `[x]` means the requirement has a reusable reference path or is external by design for this planning slice. `[ ]` means follow-up work remains before a strict package-level conformance claim.

Test-vector / schema legend:

- **Vector OK:** asserted by `packages/wot-core/tests/ProtocolInterop.test.ts` against the phase-1 vector.
- **Vector partial:** vector field exists but is not asserted from this codebase.
- **Downstream vector:** exercised by a vector that belongs to a downstream profile rather than the `wot-identity@0.1` manifest entry.
- **No vector:** no test vector covers this requirement.
- **No schema:** no JSON Schema in this profile covers this requirement.

---

## 0. General conformance (`../wot-spec/CONFORMANCE.md`)

These requirements apply to every claimed profile, including `wot-identity@0.1`. General JWS algorithm and exact-signing-input requirements are mapped as `REQ-SIG-005` and `REQ-SIG-006` below to avoid duplicate counting.

- [x] **REQ-GEN-001 — Relevant test vectors MUST be reproduced or verified.**
  - Implementation: `packages/wot-core/tests/ProtocolInterop.test.ts` reproduces or verifies the positive identity and DID-resolution vector fields listed by the `wot-identity@0.1` manifest. **Reusable** for the manifest-listed identity and DID-resolution vectors.
  - Vector: phase-1 `identity` and `did_resolution`. **Vector OK** where listed in section 5; JWS/AES ownership is tracked in [Q-7](#q-7-jws-section-ownership).
  - Schema: not applicable.

- [ ] **REQ-GEN-002 — Implementations MUST interpret `../wot-spec/GLOSSARY.md` terminology consistently.**
  - Implementation: no central glossary-conformance artifact exists in TS; terminology consistency is enforced only by local naming, docs, and reviews today. **Needs rewrite / documentation audit** before a strict conformance claim.
  - Vector: **No vector** — terminology consistency is not a deterministic interop value.
  - Schema: not applicable.

- [x] **REQ-GEN-003 — Unknown optional fields MUST be ignored unless the owning document says otherwise.**
  - Implementation: `../wot-spec/schemas/did-document-wot.schema.json` uses `additionalProperties: true`, and the hand-written `DidDocument` type only consumes known fields. Generic JWS decoding preserves extra header/payload fields for artifact-specific verifiers. **Reusable** for current identity/DID surfaces.
  - Vector: positive vectors only. **Vector partial** — no negative/extension vector asserts unknown-field tolerance.
  - Schema: DID Document schema explicitly permits additional properties.

- [x] **REQ-GEN-004 — Unknown message types MUST be safely ignored and not treated as valid known types.**
  - Implementation: `wot-identity@0.1` does not define a message dispatcher or message-type registry; downstream profiles own concrete message routing. **External by design** for this identity inventory and must be covered by trust/sync inventories.
  - Vector: **No wot-identity profile vector** — no identity-profile message-type vector exists.
  - Schema: not applicable.

- [ ] **REQ-GEN-005 — Implementations SHOULD state exactly which profiles they support.**
  - Implementation: this inventory and PR label identify `wot-identity@0.1`, but there is no machine-readable runtime conformance declaration in `packages/wot-core`. **Needs rewrite / documentation** if profile claims are expected from the package itself.
  - Vector: **No vector** — profile-claim metadata is not covered by phase-1 interop vectors.
  - Schema: not applicable.

---

## 1. Identity material derivation (spec doc `../wot-spec/01-wot-identity/001-identitaet-und-schluesselableitung.md`)

These requirements are derived from `../wot-spec/CONFORMANCE.md`, `../wot-spec/01-wot-identity/001-identitaet-und-schluesselableitung.md`, the `../wot-spec/test-vectors/phase-1-interop.json#identity` section, and the protocol-core derivation module.

### 1.1 BIP39 seed input

- [x] **REQ-ID-001 — BIP39 mnemonic-to-seed MUST use PBKDF2-HMAC-SHA512 with empty passphrase and the full 64-byte seed output.**
  - Implementation: `packages/wot-core/src/protocol/identity/key-derivation.ts` (`deriveBip39SeedFromMnemonic`) derives the 64-byte BIP39 seed with an empty passphrase, and `deriveProtocolIdentityFromMnemonic` feeds that full seed into the shared internal bytes derivation path without duplicating HKDF or DID logic. **Reusable** for the protocol reference path.
  - Legacy parallel: `packages/wot-core/src/identity/WotIdentity.ts` calls `mnemonicToSeedSync(mnemonic, '')` but then slices the first 32 bytes for legacy derivation. **Needs rewrite (legacy path)** and likely a protocol/application boundary decision for where BIP39 conversion lives.
  - Vector: phase-1 `identity.mnemonic` -> `identity.bip39_seed_hex` and mnemonic-derived material parity with `identity.bip39_seed_hex` are asserted in `packages/wot-core/tests/ProtocolInterop.test.ts`. **Vector OK** for full-seed protocol derivation and mnemonic-to-seed conversion.
  - Schema: not applicable.

- [x] **REQ-ID-002 — Implementations SHOULD default to the English BIP39 wordlist and MAY support additional wordlists.**
  - Implementation: the protocol helper `deriveBip39SeedFromMnemonic` validates against the English BIP39 wordlist by default. The demo/application German-positive wordlist behavior remains unchanged and is not used for the protocol conformance helper. **Reusable** for the protocol reference path.
  - Vector: phase-1 vector uses the standard English `abandon ... about` mnemonic, and invalid English mnemonic cases are rejected in `ProtocolInterop.test.ts`.
  - Schema: not applicable.
  - Disposition: package-level product claims still need to distinguish the protocol reference helper from the demo's localized mnemonic generation/recovery defaults.

### 1.2 HKDF derivation contexts

- [ ] **REQ-ID-003 — Identity Ed25519 seed MUST be derived via `HKDF-SHA-256(seed, info="wot/identity/ed25519/v1", L=32)`.**
  - Implementation: `packages/wot-core/src/protocol/identity/key-derivation.ts` (`IDENTITY_INFO = 'wot/identity/ed25519/v1'`). **Reusable.**
  - Legacy parallel: `packages/wot-core/src/identity/WotIdentity.ts` uses HKDF info `'wot-identity-v1'` (different string). **Needs rewrite (legacy path)** — see [Open Question Q-3](#q-3-hkdf-info-string-divergence).
  - Vector: phase-1 `identity.ed25519_seed_hex`. **Vector OK** in the `derives identity material from the phase-1 vector` test.
  - Schema: not applicable.

- [ ] **REQ-ID-004 — Encryption X25519 seed MUST be derived via `HKDF-SHA-256(seed, info="wot/encryption/x25519/v1", L=32)`.**
  - Implementation: `packages/wot-core/src/protocol/identity/key-derivation.ts` (`ENCRYPTION_INFO = 'wot/encryption/x25519/v1'`). **Reusable.**
  - Legacy parallel: `packages/wot-core/src/identity/WotIdentity.ts` uses HKDF info `'wot-encryption-v1'`. **Needs rewrite (legacy path)**.
  - Vector: phase-1 `identity.x25519_seed_hex`. **Vector OK** in the `derives identity material from the phase-1 vector` test.
  - Schema: not applicable.

Note: `docs/spec/wot-protocol-spec.md` is legacy/outdated for this profile where it documents a 32-byte seed and dash-form HKDF info strings (`wot-identity-v1`, `wot-encryption-v1`). The sibling `../wot-spec/...` files above are the normative source for this inventory; syncing or deleting the in-repo legacy spec should happen in a separate spec-sync slice.

### 1.3 Public-key derivation

- [x] **REQ-ID-005 — Ed25519 public key MUST be the curve point derived from the identity seed (RFC 8032).**
  - Implementation: `packages/wot-core/src/protocol/identity/key-derivation.ts` (`deriveProtocolIdentityFromSeedHex`, via `@noble/ed25519`). **Reusable.**
  - Vector: phase-1 `identity.ed25519_public_hex`. **Vector OK** in the `derives identity material from the phase-1 vector` test.
  - Schema: not applicable.

- [x] **REQ-ID-006 — X25519 public key MUST be derived from the X25519 seed (RFC 7748).**
  - Implementation: `packages/wot-core/src/protocol/identity/key-derivation.ts` (`deriveProtocolIdentityFromSeedHex`, via `ProtocolCryptoAdapter.x25519PublicFromSeed`). **Reusable.**
  - Vector: phase-1 `identity.x25519_public_hex` and `x25519_public_multibase`. **Vector OK** in the `derives identity material from the phase-1 vector` test. `identity.x25519_public_b64` is asserted by the `matches the space membership message vectors` test through `space_membership_messages.invite_key_discovery`, so it is **Downstream vector** coverage rather than identity-derivation coverage.
  - Schema: not applicable.

### 1.4 DID and KID

- [x] **REQ-ID-007 — `did:key` identifier MUST encode the Ed25519 public key as `did:key:z<base58btc(0xed01 || pubkey)>`.**
  - Implementation: `packages/wot-core/src/protocol/identity/did-key.ts` (`publicKeyToDidKey`, `ed25519PublicKeyToMultibase`, prefix `0xed 0x01`). **Reusable.**
  - Legacy parallel: `packages/wot-core/src/crypto/did.ts` (`createDid`) — same encoding. **Reusable** as legacy mirror (both should be deduplicated in a later slice — see [Open Question Q-4](#q-4-duplicate-did-encoders)).
  - Vector: phase-1 `identity.did`. **Vector OK** in the `derives identity material from the phase-1 vector` test.
  - Schema: covered indirectly via `did-document-wot.schema.json` `id`.

- [x] **REQ-ID-008 — Canonical signing kid MUST be `<did>#sig-0`.**
  - Implementation: `packages/wot-core/src/protocol/identity/key-derivation.ts` (`deriveProtocolIdentityFromSeedHex`). **Reusable.**
  - Vector: phase-1 `identity.kid`. **Vector OK** in the `derives identity material from the phase-1 vector` test.
  - Schema: implied by `did-document-wot.schema.json` (verificationMethod `id` `#sig-0`). **Open Question Q-5** for explicit wording.

- [x] **REQ-ID-009 — When communication-capable `keyAgreement` data is present, its canonical X25519 fragment is `#enc-0`.**
  - Implementation: `resolveDidKey` returns an empty array for bare `did:key` resolution, and `createDidKeyResolver` accepts caller-supplied `keyAgreement` data for the enriched bootstrap/vector state. This matches `../wot-spec/01-wot-identity/003-did-resolution.md`: X25519 material is not derivable from the Ed25519 `did:key` and must come from QR/profile/cache bootstrap data.
  - Disposition: **Reusable** for bare `did:key` resolution and externally supplied communication-capable documents. A later application slice should make the bootstrap/cache source explicit.
  - Vector: phase-1 `did_resolution.did_document.keyAgreement[0].id == "#enc-0"`. **Vector partial** — the test validates the fixture-supplied communication-capable document, not the bare `did:key` empty-keyAgreement state.
  - Schema: `did-document-wot.schema.json` requires the `keyAgreement` array field and validates entry shape when entries exist.
  - See [Follow-up Q-6](#q-6-communication-capable-did-document-source).

### 1.5 X25519 multibase encoding

- [x] **REQ-ID-010 — X25519 public key in DID Document MUST be encoded as `z<base58btc(0xec01 || pubkey)>`.**
  - Implementation: `packages/wot-core/src/protocol/identity/did-key.ts` (`x25519PublicKeyToMultibase`, prefix `0xec 0x01`). **Reusable.**
  - Vector: phase-1 `identity.x25519_public_multibase`. **Vector OK** in the `derives identity material from the phase-1 vector` test.
  - Schema: implied.

### 1.6 On-device seed protection

- [ ] **REQ-ID-011 — The seed MUST be adequately protected on-device and MUST NOT be extractable in plaintext.**
  - Implementation: `packages/wot-core/src/identity/SeedStorage.ts` encrypts stored seed material in IndexedDB using PBKDF2(passphrase) + AES-GCM, and `packages/wot-core/src/adapters/storage/SeedStorageIdentityVault.ts` wraps the full 64-byte BIP39 seed in a versioned envelope before storage. However, `IdentitySeedVault.loadSeed` returns plaintext `Uint8Array` seed bytes to `IdentityWorkflow`, and `ProtocolIdentitySession` keeps seed material in JS private fields for signing, decryption, and framework-key derivation. **Needs rewrite / hardening** before a strict non-extractability claim.
  - Vector: **No vector** — seed-at-rest and non-extractability are platform/security properties, not deterministic interop values.
  - Schema: not applicable.
  - Follow-up: evaluate a handle-based seed vault or platform keystore adapter so application code can derive/sign/decrypt without receiving plaintext seed bytes.

---

## 2. Signatures and verification (spec doc `../wot-spec/01-wot-identity/002-signaturen-und-verifikation.md`)

The spec covers JWS framing for identity-related artifacts. The `wot-identity@0.1` manifest does not list its own JWS test-vector section, but the JCS / JWS primitives are dependencies of every other profile and are exercised through `attestation_vc_jws`, `log_entry_jws`, and `space_capability_jws` vectors. They are inventoried here because they live under the identity-document family (see also [Open Question Q-7](#q-7-jws-section-ownership)).

### 2.1 JCS

- [x] **REQ-SIG-001 — JSON canonicalization MUST follow RFC 8785 (JCS).**
  - Implementation: `packages/wot-core/src/protocol/crypto/jcs.ts` (`canonicalize`, `canonicalizeToBytes`). **Reusable.**
  - Vector: phase-1 `did_resolution.jcs_sha256`. **Vector OK** in the `derives identity material from the phase-1 vector` test. `attestation_vc_jws.payload_jcs_sha256` also exercises JCS, but it is **Downstream vector** coverage from `wot-trust@0.1`.
  - Schema: not applicable.
  - Notes: current vectors do not exercise finite-number edge cases such as exponent formatting, shortest-roundtrip decimals, or `-0` normalization. Spec-side coverage question — see [Open Question Q-8](#q-8-jcs-number-edge-cases).

### 2.2 JWS framing

- [ ] **REQ-SIG-002 — Identity-issued JWS MUST use compact serialization with `alg=EdDSA`, JCS-canonicalized header and payload, and Ed25519 signature over `BASE64URL(JCS(header)) || "." || BASE64URL(JCS(payload))`.**
  - Implementation: `packages/wot-core/src/protocol/crypto/jws.ts` (`createJcsEd25519Jws`, `verifyJwsWithPublicKey`). **Reusable.**
  - Legacy parallel: `packages/wot-core/src/crypto/jws.ts` and `packages/wot-core/src/application/identity/identity-workflow.ts` (`ProtocolIdentitySession.signJws`) use non-canonical `JSON.stringify` and a fixed `typ: 'JWT'` header. They are incompatible byte-for-byte with the protocol-core path. **Needs rewrite (legacy path)** — see [Open Question Q-9](#q-9-legacy-jws-callers).
  - Vector: **No wot-identity profile vector** for generic JWS compact serialization. The attestation, log-entry, space-capability, and device-binding tests exercise the same primitive as **Downstream vector** coverage.
  - Schema: not applicable.

- [x] **REQ-SIG-003 — Every WoT JWS MUST set `kid`, and verifiers MUST evaluate it.**
  - Implementation: `createJcsEd25519JwsWithSigner` requires a non-empty string `kid`, `createJcsEd25519Jws` shares that path, and `verifyJwsWithPublicKey` rejects missing or empty `kid` before signature verification. Artifact-specific verifiers still own context consistency checks such as attestation issuer, log-entry `authorKid`, and capability `spaceId`/generation binding. **Reusable** for the protocol-core JWS helper surface.
  - Vector: phase-1 attestation, log-entry, and capability JWS vectors all carry `kid` values and are verified through artifact-specific tests. `ProtocolInterop.test.ts` adds focused negative coverage for missing and empty generic JWS `kid` values; there is no separate `wot-spec` negative vector yet.
  - Schema: not applicable.

- [ ] **REQ-SIG-004 — DID-bound signatures MUST resolve the signing key through `kid` -> `resolve(did)` -> DID Document and purpose binding.**
  - Implementation: `packages/wot-core/src/protocol/identity/did-key.ts` (`didKeyToPublicKeyBytes`) supports Phase-1 `did:key` extraction, and higher-level verifiers use it for current vectors. The generic path is not method-agnostic and does not consume the `DidResolver` port yet. **Needs rewrite** for the full DID-method-agnostic `resolve(did)` architecture.
  - Vector: phase-1 attestation/device-binding JWS verification exercises `did:key`-derived public keys. No vector asserts a non-`did:key` resolver or an unknown/uncached DID returning `null`.
  - Schema: not applicable.

- [x] **REQ-SIG-005 — Verifiers MUST whitelist `alg=EdDSA` and reject all other algorithms before signature verification.**
  - Implementation: `createJcsEd25519JwsWithSigner` and `verifyJwsWithPublicKey` reject unsupported `alg`. **Reusable.**
  - Vector: positive EdDSA vectors plus focused `ProtocolInterop.test.ts` negative coverage showing unsupported `alg` rejection before `verifyEd25519` is called. **Vector partial** — no spec-owned algorithm-confusion vector yet.
  - Schema: not applicable.

- [x] **REQ-SIG-006 — Verifiers MUST verify the signature over the exact received JWS signing-input bytes, without re-canonicalizing the payload.**
  - Implementation: `decodeJws` preserves `${encodedHeader}.${encodedPayload}` as `signingInput`, rejects unambiguous malformed compact serialization, and `verifyJwsWithPublicKey` verifies those exact bytes. **Reusable.**
  - Vector: focused `ProtocolInterop.test.ts` coverage verifies non-JCS received payload bytes exactly as received and rejects tampered received compact JWS payload bytes. Attestation, log-entry, capability, and device-binding interop tests provide **Downstream vector** coverage.
  - Schema: not applicable.

- [x] **REQ-SIG-007 — JWS `typ` values MUST be the per-document spec values where the owning document defines one.**
  - Implementation: enforced per artifact (see `device-key-binding.ts`, `attestation-vc-jws.ts`, `space-capability.ts`). **Reusable** at the per-artifact level.
  - Vector: `attestation_vc_jws.header.typ == "vc+jwt"` is **Downstream vector** coverage from `wot-trust@0.1`; `wot-identity@0.1` has no own `typ` vector.
  - Schema: per-artifact schemas (not in `wot-identity@0.1` profile).
  - Notes: `wot-identity@0.1` owns the JWS mechanics; downstream profiles own their `typ` strings.

---

## 3. DID resolution (spec doc `../wot-spec/01-wot-identity/003-did-resolution.md`)

### 3.1 `did:key` resolution

- [x] **REQ-RES-001 — Resolving a `did:key:z6Mk…` MUST return a DID Document whose `id` equals the input DID.**
  - Implementation: `packages/wot-core/src/protocol/identity/did-key.ts` (`resolveDidKey`). **Reusable.**
  - Vector: phase-1 `did_resolution.did_document.id`. **Vector OK** in the `derives identity material from the phase-1 vector` test.
  - Schema: `did-document-wot.schema.json` `id`.

- [x] **REQ-RES-002 — DID Document MUST contain a single Ed25519 verification method with `id="#sig-0"`, `type="Ed25519VerificationKey2020"`, `controller=<did>`, and `publicKeyMultibase` matching `z<base58btc(0xed01 || pubkey)>`.**
  - Implementation: `packages/wot-core/src/protocol/identity/did-key.ts` (`resolveDidKey`). **Reusable.**
  - Vector: phase-1 `did_resolution.did_document.verificationMethod[0]`. **Vector OK**.
  - Schema: `did-document-wot.schema.json` requires each `verificationMethod` item to contain `id`, `type`, `controller`, and `publicKeyMultibase`.

- [x] **REQ-RES-003 — DID Document MUST list `#sig-0` in `authentication` and `assertionMethod`.**
  - Implementation: `packages/wot-core/src/protocol/identity/did-key.ts` (`resolveDidKey`). **Reusable.**
  - Vector: phase-1 `did_resolution.did_document.authentication`, `.assertionMethod`. **Vector OK**.
  - Schema: implied.

- [x] **REQ-RES-004 — DID Document MUST contain a `keyAgreement` array, but bare `did:key` resolution MAY return it empty and consumers MUST treat missing key-agreement data as non-communicative state, not a signature error.**
  - Implementation: `resolveDidKey` returns `keyAgreement: []`, and `createDidKeyResolver` can be configured with caller-supplied `keyAgreement` data from bootstrap/profile/cache sources. **Reusable.**
  - Disposition: **Reusable** for the spec's two DID-document states: signature-capable bare `did:key` and communication-capable externally enriched documents. The implementation still needs an application-level source-of-truth slice for QR/profile/cache enrichment.
  - Vector: phase-1 `did_resolution.did_document.keyAgreement[0]`. **Vector partial** — the test validates the enriched fixture-supplied document; there is no explicit vector for the bare empty array state.
  - Schema: `did-document-wot.schema.json` requires the `keyAgreement` field and validates entries when present, but permits an empty array.
  - See [Follow-up Q-6](#q-6-communication-capable-did-document-source).

- [x] **REQ-RES-005 — DID Document MAY include `service` entries (e.g. `WoTInbox`).**
  - Implementation: `packages/wot-core/src/protocol/identity/did-key.ts` (`resolveDidKey`). **Reusable.**
  - Vector: phase-1 `did_resolution.did_document.service`. **Vector OK**.
  - Schema: `did-document-wot.schema.json` validates optional `service` entries with `id`, `type`, and `serviceEndpoint`.

- [x] **REQ-RES-006 — JCS-SHA256 over the resolved DID Document MUST equal the published vector hash (interop fingerprint).**
  - Implementation: composed at test time via `cryptoAdapter.sha256(canonicalizeToBytes(...))`. **Reusable** (no production code path computes this hash today; that is acceptable because it is a vector-only invariant).
  - Vector: phase-1 `did_resolution.jcs_sha256`. **Vector OK**.
  - Schema: not applicable.

### 3.2 DID Resolver port

- [x] **REQ-RES-007 — A conforming client MUST implement `resolve(did)` for supported DID methods and return a `DidDocument | null`; `did:key` is normative in Phase 1.**
  - Implementation: `resolveDidKey` implements deterministic Phase-1 `did:key` construction, and `createDidKeyResolver` exposes the pure protocol `DidResolver` shape for Phase-1 `did:key`. Unsupported DID methods return `null`; malformed `did:key` values also resolve to `null`. No storage, network, profile-service, adapter, or cache behavior is introduced in protocol-core. **Reusable** for Phase-1 `did:key`.
  - Vector: phase-1 `did_resolution.did_document` covers positive enriched `did:key` resolution, and `ProtocolInterop.test.ts` adds focused protocol assertions for bare `keyAgreement: []`, enriched `#enc-0`/`WoTInbox` parity, and unsupported methods returning `null`. Missing vectors: known method with missing document and offline cache behavior, which belong to later application/cache slices.
  - Schema: successful results are shaped by `did-document-wot.schema.json`; `null` cases are outside JSON Schema.

---

## 4. Schema coverage (`../wot-spec/schemas/did-document-wot.schema.json`)

The DID Document type in `packages/wot-core/src/protocol/identity/did-document.ts` is a hand-written TypeScript interface that mirrors the phase-1 vector shape and the schema's required fields, not a generated type from the schema. Fields covered by `did-document-wot.schema.json` and validated implicitly by the phase-1 interop test:

- `id` (string)
- `verificationMethod[].{id,type,controller,publicKeyMultibase}`
- `authentication[]`, `assertionMethod[]` (string fragments)
- `keyAgreement` as a required array; `keyAgreement[].{id,type,controller,publicKeyMultibase}` when entries are present
- `service[].{id,type,serviceEndpoint}` (when present)

Gaps:

- No JSON-Schema-level validation in TS (`@web_of_trust/core` defers schema validation to `wot-spec` per `packages/wot-core/src/protocol/COVERAGE.md`). **No schema** check in TS today.
- No runtime JSON Schema validation in TS; TypeScript structural typing does not enforce schema regex patterns.
- No negative tests for malformed `id`, `controller`, `publicKeyMultibase`, or missing required arrays.
- `capabilityDelegation[]` is schema-only coverage today: the schema allows it, but the phase-1 `did_resolution.did_document` vector and the TS `DidDocument` interface do not model or assert it.

Disposition: **Reusable** as runtime types; schema-conformance validation is consciously deferred to the spec repository.

---

## 5. Test-vector coverage (`phase-1-interop.json` sections `identity`, `did_resolution`)

Vector field | Asserted in `ProtocolInterop.test.ts` | Notes
---|---|---
`identity.bip39_seed_hex` | yes | Asserted as the output of `deriveBip39SeedFromMnemonic(identity.mnemonic)` and consumed by `deriveProtocolIdentityFromSeedHex`.
`identity.ed25519_seed_hex` | yes (`expect(bytesToHex(identity.ed25519Seed))`) |
`identity.ed25519_public_hex` | yes |
`identity.x25519_seed_hex` | yes |
`identity.x25519_public_hex` | yes |
`identity.x25519_public_b64` | yes, downstream | Asserted via `space_membership_messages.invite_key_discovery.x25519_public_b64 === identity.x25519_public_b64` in the space-membership-message vector test.
`identity.x25519_public_multibase` | yes (via `x25519PublicKeyToMultibase`) |
`identity.did` | yes |
`identity.kid` | yes |
`identity.mnemonic` | yes | Asserted through English BIP39 mnemonic-to-64-byte-seed conversion and mnemonic-derived identity material parity.
`did_resolution.did_document` | yes (`expect(didDocument).toEqual(...)`) |
`did_resolution.jcs_sha256` | yes |

Coverage gaps:

- No negative test vectors for `did:key` resolution (e.g. wrong multicodec prefix, malformed base58btc, wrong DID method). The implementation throws from `didKeyToPublicKeyBytes`, `ed25519MultibaseToPublicKeyBytes`, and `x25519MultibaseToPublicKeyBytes`, but no vector asserts the error message family.

---

## 6. Reference-implementation map

Spec area | Canonical TS module(s) | Legacy / parallel module(s) | Disposition
---|---|---|---
Seed -> identity material | `protocol/identity/key-derivation.ts` | `identity/WotIdentity.initFromSeed`, `crypto/did.ts` | **Needs rewrite** of legacy paths to the protocol-core HKDF info strings before they can claim `wot-identity@0.1` conformance.
`did:key` encoding | `protocol/identity/did-key.ts` | `crypto/did.ts` (`createDid`, `didToPublicKeyBytes`) | **Needs rewrite (dedupe).** Both encoders are byte-compatible today but should converge on `protocol/identity/did-key.ts`.
DID Document type | `protocol/identity/did-document.ts` | none | **Reusable.**
`did:key` resolution helper | `protocol/identity/did-key.ts:resolveDidKey`, `protocol/identity/did-key.ts:createDidKeyResolver`, `protocol/identity/did-document.ts` (`DidResolver`) | none | **Reusable** for pure Phase-1 `did:key` resolution. Application/cache/profile-service resolver composition remains a later slice (see Q-11).
JCS | `protocol/crypto/jcs.ts` | none | **Reusable.**
JWS create / verify | `protocol/crypto/jws.ts` | `crypto/jws.ts` (legacy), `application/identity/identity-workflow.ts` (`ProtocolIdentitySession.signJws`) | **Needs rewrite (legacy path).** Legacy paths use `JSON.stringify` and `typ: 'JWT'`; `crypto/jws.ts` also uses Web Crypto `Ed25519` directly. Migrating remaining callers is tracked in [`docs/reference-implementation-refactor.md`](../reference-implementation-refactor.md) slices 2 (Identity) and 4 (Attestations).
Mnemonic + wordlist | `protocol/identity/key-derivation.ts` (`deriveBip39SeedFromMnemonic`, `deriveProtocolIdentityFromMnemonic`) | `application/identity/identity-workflow.ts`, `wordlists/german-positive.ts`, `identity/WotIdentity.ts` | **Reusable** for the protocol reference path. Demo/application German-positive behavior remains a separate product choice and is not changed by the protocol seed slice (see Q-2).

---

## 7. Open Spec Questions and Follow-ups

These items surfaced while inventorying. Some are now resolved by the current `wot-spec` text and remain here as implementation follow-ups; unresolved normative questions should become a separate spec PR or issue rather than an implementation guess.

### Q-1: Full BIP39 seed input

Resolved by `../wot-spec/01-wot-identity/001-identitaet-und-schluesselableitung.md`: the BIP39 passphrase is always `""`, the output is 64 bytes, and HKDF uses the full 64 bytes with no slicing. The protocol helper now derives and uses the full 64-byte BIP39 seed. Implementation follow-up: legacy `WotIdentity.initFromSeed` slices the first 32 bytes before HKDF and must not be used for a `wot-identity@0.1` conformance claim.

### Q-2: Mnemonic wordlist

Resolved by `../wot-spec/01-wot-identity/001-identitaet-und-schluesselableitung.md`: implementations SHOULD default to the English BIP39 wordlist and MAY support additional wordlists. The protocol helper now defaults to English and reproduces the phase-1 English vector. Implementation follow-up: if the demo keeps the German-positive wordlist as the visible default, document that as a product choice and avoid presenting it as strict adherence to the English-default SHOULD.

### Q-3: HKDF info-string divergence

Resolved by `../wot-spec/CONFORMANCE.md` and `../wot-spec/01-wot-identity/001-identitaet-und-schluesselableitung.md`: the slash-separated `wot/identity/ed25519/v1` and `wot/encryption/x25519/v1` info strings are normative for this profile. Implementation follow-up: legacy dash-form HKDF strings must be removed or fenced off from the reference path.

### Q-4: Duplicate DID encoders

Two byte-identical `did:key` encoders coexist (`protocol/identity/did-key.ts` and `crypto/did.ts`). This is an implementation question, not a spec question, but it should be resolved alongside the larger `WotIdentity` migration. Recording here so the next slice picks it up.

### Q-5: Verification-method id `#sig-0`

Resolved by `../wot-spec/01-wot-identity/003-did-resolution.md` for Phase-1 `did:key`: the generated DID Document uses `#sig-0` in `verificationMethod`, `authentication`, and `assertionMethod`. Implementation follow-up: legacy public-key-fragment DID documents should be migrated or explicitly treated as non-reference behavior.

### Q-6: Communication-capable DID document source

Resolved by `../wot-spec/01-wot-identity/003-did-resolution.md`: bare `did:key` resolution returns a signature-capable DID Document with `keyAgreement: []`; X25519 data is not derivable from the Ed25519 `did:key` and is populated from QR-code bootstrap, profile service, or local cache. Implementation follow-up: add explicit tests and application wiring for both states: bare non-communicative DID Document and enriched communication-capable DID Document with `#enc-0`.

### Q-7: JWS section ownership

The `wot-identity@0.1` profile lists `../wot-spec/01-wot-identity/001-identitaet-und-schluesselableitung.md`, `../wot-spec/01-wot-identity/002-signaturen-und-verifikation.md`, and `../wot-spec/01-wot-identity/003-did-resolution.md` as its spec docs but only `../wot-spec/test-vectors/phase-1-interop.json#identity` and `#did_resolution` as its manifest-owned test vectors. `../wot-spec/01-wot-identity/002-signaturen-und-verifikation.md` says conforming implementations must reproduce three test-vector families: identity, JWS signature, and AES-256-GCM. That conflicts with the manifest scope: JWS vectors currently live under downstream artifacts such as `attestation_vc_jws`, `log_entry_jws`, `space_capability_jws`, and device delegation, while AES-GCM vectors are exercised through sync/encryption surfaces rather than the identity manifest entry. Spec follow-up is tracked in [`wot-spec` issue #16](https://github.com/real-life-org/wot-spec/issues/16): decide whether `wot-identity@0.1` should list JWS/AES vector sections directly, or whether Identity 002 should say those vectors are downstream coverage for profiles that require identity primitives.

### Q-8: JCS number edge cases

`packages/wot-core/src/protocol/crypto/jcs.ts` (`canonicalize`) rejects non-finite numbers, normalizes `-0` to `0`, and delegates finite-number formatting to `JSON.stringify` / ECMAScript number serialization. The current vectors do not exercise float edge cases. [`wot-spec` issue #17](https://github.com/real-life-org/wot-spec/issues/17) tracks whether dedicated JCS number-edge vectors should be added or whether the current integer/string-heavy artifact coverage is sufficient for Phase 1.

### Q-9: Legacy JWS callers

`packages/wot-core/src/crypto/jws.ts` produces non-JCS, `typ: 'JWT'` JWS values incompatible with the protocol-core JWS shape. It is still consumed by `WotIdentity.signJws`, `services/ProfileService.ts`, and `crypto/capabilities.ts`; `packages/wot-core/src/application/identity/identity-workflow.ts` (`ProtocolIdentitySession.signJws`) also builds non-JCS `typ: 'JWT'` JWS values directly. None of those artifacts are in scope for `wot-identity@0.1` proper, but they share the JWS surface. This is an implementation question (migration path), not a spec question — listed so the follow-up identity slice does not silently re-introduce the legacy framing.

### Q-10: DID Document schema validation

The hand-written `DidDocument` interface matches the schema-required fields used by current vectors, and the schema allows additional properties. Implementation follow-up: decide whether TS should run JSON Schema validation for inbound DID Documents or continue treating schema validation as a spec-repo conformance artifact only.

### Q-11: `DidResolver` port

`wot-identity@0.1` requires `resolve(did)` for `did:key`; `resolveDidKey` implements the deterministic Phase-1 method, while `createDidKeyResolver` exposes the concrete pure protocol resolver surface for Phase-1. Implementation follow-up: application and downstream verifier code should depend on composed resolver ports so non-`did:key` methods, cache hits, cache misses, and profile-service lookups can be added without bypassing the architecture.

### Q-12: Seed vault hardening

`../wot-spec/01-wot-identity/001-identitaet-und-schluesselableitung.md` requires protected on-device seed storage and no plaintext extractability. The current browser storage path encrypts seed-at-rest, but the application-facing `IdentitySeedVault` still returns plaintext bytes after unlock. Implementation follow-up: decide whether strict conformance requires a non-extractable handle-based vault, platform keystore integration, or a documented browser-threat-model exception.

---

## 8. Conformance summary

Requirement bucket | Reusable | Needs rewrite | Missing | External | Total
---|---:|---:|---:|---:|---:
General conformance | 2 | 2 | 0 | 1 | 5
Identity material derivation | 8 | 3 | 0 | 0 | 11
Signatures and verification | 5 | 2 | 0 | 0 | 7
DID resolution | 7 | 0 | 0 | 0 | 7
**Total** | **22** | **7** | **0** | **1** | **30**

The protocol-core path under `packages/wot-core/src/protocol/` covers the current positive phase-1 identity and DID-resolution vectors, including English BIP39 mnemonic-to-full-seed derivation, bare/enriched `did:key` resolver behavior, unsupported/malformed DID handling, plus focused JWS/JCS behavior for sender-side canonical signing input, required `kid`, unsupported-alg rejection before crypto verification, exact received signing-input verification, tampered bytes, and unambiguous malformed compact serialization. The remaining "needs rewrite" count is dominated by legacy parallels in `packages/wot-core/src/identity/` and `packages/wot-core/src/crypto/`, DID-bound generic verifier resolver-port wiring, and seed-vault hardening. The migration is already planned in [`docs/reference-implementation-refactor.md`](../reference-implementation-refactor.md) slices 2 (Identity) and 4 (Attestations) and should be tracked there rather than re-opened in this profile.

No runtime module is marked fully missing for `wot-identity@0.1`: bare `did:key` resolution and encrypted seed-at-rest storage exist. The next implementation slices should add negative/edge vectors, application/cache/profile-service resolver composition, and seed-vault hardening before removing legacy identity/JWS code.

## 9. Out of scope for this protocol seed implementation slice

- No changes outside the protocol-core reference slice, focused tests, and conformance inventory/docs.
- No edits to `../wot-spec/`; normative spec changes remain separate human-approved spec PRs.
- No demo, app, adapter, CRDT, discovery/profile-service cache, sync, relay, vault, legacy crypto, service, or application workflow changes.
- No automation workflow changes (`.github/` forbidden).
- The legacy-path migration is tracked in [`docs/reference-implementation-refactor.md`](../reference-implementation-refactor.md), not in this document.
- Profiles other than `wot-identity@0.1` (i.e. `wot-trust@0.1`, `wot-sync@0.1`, `wot-device-delegation@0.1`, `wot-rls@0.1`, `wot-hmc@0.1`) are out of scope and continue to be tracked in `packages/wot-core/src/protocol/COVERAGE.md`.
