# Architecture Decisions

> Documented decisions and open questions for the Web of Trust project.

**Last updated:** 2026-03-16

---

## Confirmed Decisions

### Identity

| Decision | Choice | Rationale |
|----------|--------|-----------|
| DID method | **did:key** (Ed25519, multibase) | Self-certifying, no infrastructure, offline-capable. See [Identity & Keys](../concepts/identity-and-keys.md) |
| Key derivation | **BIP39 → HKDF → Ed25519** | Deterministic, portable, non-extractable private key |
| Wordlist | **German (dys2p)** | Primary community is German-speaking |
| Mnemonic length | **12 words** | Sufficient entropy, easier to write down than 24 |
| Recovery quiz | **Mandatory at onboarding** | Prevents "I didn't write it down" scenario |
| Show phrase later? | **No** | Security risk if phrase is accessible in-app |

### CRDT & Storage

| Decision | Choice | Rationale | Date |
|----------|--------|-----------|------|
| Default CRDT | **Yjs** (pure JavaScript) | 10-76x faster than Automerge on mobile, no WASM. See [Benchmark](/benchmark) | 2026-03-15 |
| Alternative CRDT | **Automerge** (available via `VITE_CRDT=automerge`) | Kept as option, adapters are swappable | 2026-03-15 |
| Previous CRDT | ~~Evolu~~ (removed) | Replaced by Automerge, then Yjs. History only. | 2026-02 |
| Local persistence | **CompactStore** (IndexedDB) | Single snapshot per doc, replaces automerge-repo chunked storage | 2026-03-14 |
| Sync architecture | **Four-Way** (CompactStore + Relay + Vault + wot-profiles) | Each path serves a different purpose. See [Sync Architecture](../architecture/sync.md) | 2026-03 |

### Encryption

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Group encryption | **AES-256-GCM per Space** (GroupKeyService) | Simple, sufficient for POC group sizes |
| 1:1 encryption | **X25519 ECIES** | Asymmetric encryption for attestation delivery |
| Envelope auth | **Ed25519 signed envelopes** | Sender authentication, replay protection |
| Profile signing | **JWS (Ed25519)** | Public profiles, anyone can verify |
| Future: group E2EE | Keyhive/BeeKEM (observe) | Pre-alpha, earliest 2027 |
| Future: MLS | RFC 9420 (evaluate) | Standard, but needs server ordering |

### Data Model

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Receiver Principle | **Attestations/verifications stored at recipient** | Data sovereignty, no write conflicts |
| Attestation visibility | **Recipient can hide (`accepted: false`)** | Control over own profile |
| Verification visibility | **Cannot be hidden** | Controls contact status |
| Negative attestations | **No** | Too complex social dynamics |
| Self-attestations | **Possible but lower trust** | "I can repair bikes" — less weight than peer attestation |
| Attestations for hidden contacts | **Allowed** | Attestation = statement about the past |

### Adapter Architecture

| Decision | Choice | Rationale | Date |
|----------|--------|-----------|------|
| Architecture | **7 adapters** (v2) | Storage, ReactiveStorage, Crypto, Discovery, Messaging, Replication, Authorization | 2026-02-08 |
| Discovery added | **7th adapter** (was 6) | Public profile lookup via wot-profiles | 2026-02 |
| Authorization | **UCAN-inspired capabilities** | Offline-verifiable, delegable, attenuable | 2026-03 |
| Messaging (POC) | **Custom WebSocket Relay** | Simple, E2EE, delivery ACK | 2026-02 |
| Messaging (production) | **Matrix** (planned) | Ed25519 compatible, Megolm E2EE, federation | deferred |

### Groups & Governance

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Admin model | **Admin-based** (not quorum) | Simpler, CRDT-compatible |
| Admin loss | **Recommend multi-admin** | UI warning when only 1 admin |
| Future | Quorum-based governance | See [Quorum Concept](quorum-concept.md) |

### Offline

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Offline verification | **Yes** | QR scan needs no network, sync later |
| Offline attestation | **Yes** | Created locally, delivered via Outbox when online |

---

## Open Questions

### Technical

| Question | Context | Status |
|----------|---------|--------|
| Device registry | Show which devices have access | Concept exists, not implemented |
| Key rotation | did:key cannot rotate (DID = key) | Deferred — Social Recovery first |
| Matrix integration | When to switch from custom Relay? | Deferred — Relay works well for POC |

### Conceptual

| Question | Context | Status |
|----------|---------|--------|
| Group attestations | Group attests collectively | Open |
| Content types | Calendar, map, offers | Planned, not yet implemented |
| Selective sharing UI | Item-Key model exists, no user-facing feature | Planned |

### UX

| Question | Context | Status |
|----------|---------|--------|
| Onboarding without verification | User wants to try app first | First contact can be manual? |
| Recovery quiz difficulty | Older users (70+) | Simplified variant? |
| Public profiles | Should profiles be discoverable without verification? | Implemented via wot-profiles |

---

## Known Limitations

| Limitation | Rationale |
|------------|-----------|
| No anonymous usage | Verification = someone knows you |
| Server sees metadata (DIDs, timestamps) | Trade-off for usability. Content is E2EE. |
| Verifications are immutable | By design — cannot unsee a meeting |
| No group chat | Focus on attestations, not messaging |
| No payment features | Out of scope |

---

## Decision Timeline

| Date | Decisions |
|------|-----------|
| **2026-03-15** | Yjs as default CRDT (76x faster on mobile). Automerge kept as option. Benchmark page published. |
| **2026-03-14** | CompactStore replaces automerge-repo (IDB chunk accumulation → OOM). VaultPushScheduler (5s debounce). |
| **2026-03-13** | Vault sync architecture documented. Snapshot-replace pattern chosen over incremental. |
| **2026-03** | AuthorizationAdapter implemented (InMemory + capabilities.ts). UCAN-inspired, SignFn pattern. |
| **2026-03** | DiscoveryAdapter implemented (HttpDiscoveryAdapter, wot-profiles service). 7th adapter. |
| **2026-03** | Delivery ACK protocol. Relay persists until client ACK, redelivery on reconnect. |
| **2026-02-08** | 7-adapter architecture v2. Framework evaluation (16 evaluated, 6 eliminated). |
| **2026-02-07** | did:key confirmed after evaluating 6 DID methods. |
| **2026-02** | Evolu chosen for local storage, Automerge for cross-user (both later replaced). |
| **2026-01** | Receiver Principle. Recovery quiz mandatory. did:key over did:wot. |

---

*Replaces: open-questions.md (decision log was outdated, many entries from pre-Yjs era)*
