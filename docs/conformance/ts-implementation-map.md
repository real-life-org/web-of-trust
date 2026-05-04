# TypeScript Implementation Map

## Purpose

This is the high-level ledger for `wot-spec` to TypeScript implementation progress. It complements `packages/wot-core/src/protocol/COVERAGE.md`, which tracks lower-level protocol vector coverage.

`wot-spec` remains normative. This map only records what the TypeScript implementation currently claims and how that claim is tested.

## Status Legend

- `not-started`: no intentional TS implementation yet.
- `planned`: scoped in Spec Kit or an open task, but not merged in this branch.
- `partial`: some behavior exists, but the profile or workflow is not fully covered.
- `vector-covered`: vectors pass for the named surface, but broader behavior may remain.
- `implemented`: implementation and targeted tests exist for the claimed surface.
- `external`: intentionally validated outside TS core.
- `blocked`: needs a human/spec decision.
- `superseded`: old implementation path exists but should not receive new work.

## Quality Gates

Every implementation row should eventually name:

- Normative spec document, schema, or vector.
- TS implementation path.
- Test file or command.
- Legacy impact, if any.
- PR or commit that changed the status.

## Profile Map

| Profile | Spec Source | TS Surface | Test Evidence | Status | Notes |
|---|---|---|---|---|---|
| `wot-identity@0.1` | `wot-spec/01-wot-identity/001-identitaet-und-schluesselableitung.md` | `packages/wot-core/src/protocol/identity/key-derivation.ts`, `packages/wot-core/src/protocol/identity/did-key.ts` | `packages/wot-core/tests/ProtocolInterop.test.ts` | `implemented` | Seed derivation, Ed25519/X25519 material, DID, kid, multibase vector coverage. |
| `wot-identity@0.1` | `wot-spec/01-wot-identity/003-did-resolution.md`, `schemas/did-document-wot.schema.json` | `packages/wot-core/src/protocol/identity/did-document.ts`, `packages/wot-core/src/protocol/crypto/jcs.ts` | `packages/wot-core/tests/ProtocolInterop.test.ts` | `implemented` | DID document and JCS hash vector coverage. |
| `wot-trust@0.1` | `wot-spec/02-wot-trust/001-attestations.md`, `schemas/attestation-vc-payload.schema.json` | `packages/wot-core/src/protocol/trust/attestation-vc-jws.ts` | `packages/wot-core/tests/ProtocolInterop.test.ts` | `vector-covered` | VC-JWS vector behavior exists; full trust workflow coverage remains application-level work. |
| `wot-trust@0.1` | `wot-spec/02-wot-trust/002-verifikation.md`, `schemas/qr-challenge.schema.json` | `packages/wot-core/src/application/verification/` | `packages/wot-core/tests/VerificationWorkflow.test.ts`, `packages/wot-core/tests/VerificationIntegration.test.ts` | `partial` | Needs explicit mapping from current workflow tests to normative challenge/verification requirements. |
| `wot-sync@0.1` | `wot-spec/03-wot-sync/001-verschluesselung.md` | `packages/wot-core/src/protocol/sync/encryption.ts`, `packages/wot-core/src/protocol-adapters/web-crypto.ts` | `packages/wot-core/tests/ProtocolInterop.test.ts` | `implemented` | ECIES and log payload encryption vectors covered. |
| `wot-sync@0.1` | `wot-spec/03-wot-sync/002-sync-protokoll.md` | `packages/wot-core/src/protocol/sync/log-entry.ts` | `packages/wot-core/tests/ProtocolInterop.test.ts` | `implemented` | Log entry JWS vector coverage. Broader sync policy is still application/adapter work. |
| `wot-sync@0.1` | `wot-spec/03-wot-sync/003-transport-und-broker.md`, `schemas/didcomm-plaintext-message.schema.json` | none in TS protocol core | `wot-spec` DIDComm library checks | `external` | DIDComm plaintext envelope compatibility is intentionally validated in `wot-spec`, not reimplemented in core. |
| `wot-sync@0.1` | `wot-spec/03-wot-sync/004-discovery.md`, `schemas/profile-service-response.schema.json` | `packages/wot-core/src/adapters/discovery/`, `packages/wot-core/src/services/GraphCacheService.ts` | `packages/wot-core/tests/OfflineFirstDiscoveryAdapter.test.ts`, `packages/wot-core/tests/GraphCacheService.test.ts` | `partial` | Needs conformance mapping between discovery spec and current adapter/service behavior. |
| `wot-sync@0.1` | `wot-spec/03-wot-sync/005-gruppen.md`, `schemas/capability-payload.schema.json` | `packages/wot-core/src/protocol/sync/space-capability.ts`, `packages/wot-core/src/protocol/sync/admin-key.ts` | `packages/wot-core/tests/ProtocolInterop.test.ts` | `implemented` | Capability and admin key vectors covered. |
| `wot-sync@0.1` | `wot-spec/03-wot-sync/005-gruppen.md`, `schemas/member-update.schema.json`, `phase-1-interop.json#space_membership_messages` | planned `packages/wot-core/src/protocol/sync/membership-messages.ts` | planned `packages/wot-core/tests/ProtocolInterop.test.ts` | `planned` | Spec Kit slice `specs/001-member-update-message-validation/` and PR #15 candidate cover message validation. Full membership state application remains open. |
| `wot-sync@0.1` | `wot-spec/03-wot-sync/006-personal-doc.md` | `packages/wot-core/src/protocol/sync/personal-doc.ts` | `packages/wot-core/tests/ProtocolInterop.test.ts` | `implemented` | Personal Doc key and deterministic document ID vector coverage. |
| `wot-device-delegation@0.1` | `wot-spec/01-wot-identity/004-device-key-delegation.md` | `packages/wot-core/src/protocol/identity/device-key-binding.ts`, `packages/wot-core/src/protocol/trust/delegated-attestation-bundle.ts` | `packages/wot-core/tests/ProtocolInterop.test.ts` | `implemented` | Device binding, delegated attestation bundle, and invalid-case vectors covered. |
| `wot-rls@0.1` | `wot-spec/04-rls-extensions/R01-badges.md` | none | none | `not-started` | Extension fields not yet targeted by TS reference implementation. |
| `wot-hmc@0.1` | `wot-spec/05-hmc-extensions/H01-trust-scores.md`, `schemas/trust-list-delta.schema.json` | `packages/wot-core/src/protocol/trust/sd-jwt-vc.ts` | `packages/wot-core/tests/ProtocolInterop.test.ts` | `vector-covered` | SD-JWT trust-list vector exists; complete HMC behavior is not implemented. |
| `wot-hmc@0.1` | `wot-spec/05-hmc-extensions/H02-transactions.md`, `H03-gossip.md` | none | none | `not-started` | Out of current TS conformance scope. |

## Slice Ledger

| Slice | Status | Spec Kit Path | Expected Map Change | Notes |
|---|---|---|---|---|
| Member-update message validation | `planned` | `specs/001-member-update-message-validation/` | Move `space_membership_messages` from `planned` to `implemented` for message validation only. | Full membership state application should be a follow-up slice. |

## Update Rule

Any PR that changes TypeScript conformance must update this file in the same PR. If a PR intentionally does not change this map, the PR body or runner summary should say why.
