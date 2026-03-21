# NLNet NGI Zero Commons Fund — Application

**Fund:** NGI Zero Commons Fund
**Deadline:** April 1, 2026, 12:00 CEST
**Hinweis:** Diese Bewerbung wurde mit Unterstützung von Claude (Anthropic, Opus 4.6) erstellt. Siehe AI-Disclosure am Ende.

---

## Contact Information

- **Name:** Anton Tranelis
- **Email:** [AUSFÜLLEN]
- **Phone:** [AUSFÜLLEN]
- **Organisation:** (none — applying as individual)
- **Country:** Germany

---

## General Project Information

### Proposal Name

**Web of Trust — Decentralized Identity and Trust Infrastructure for Community Networks**

### Website / Wiki

https://github.com/antontranelis/web-of-trust

### Abstract

Web of Trust is a framework-agnostic, open-source library for decentralized identity, in-person verification, and end-to-end encrypted collaboration — built entirely on W3C standards (did:key, Ed25519) without reliance on any centralized infrastructure.

The project provides a modular adapter architecture that enables local communities to establish trust networks based on real-world encounters rather than platform-controlled reputation systems. Users create a self-sovereign identity from a BIP39 mnemonic seed phrase, verify each other through in-person QR-code exchanges, issue signed attestations about skills and contributions, and collaborate in encrypted CRDT-based group spaces.

**What exists today (working prototype):**
- Identity system with BIP39 mnemonics, Ed25519 signing, X25519 encryption, and did:key identifiers
- In-person verification protocol with challenge-response and QR-code exchange
- Attestation system with end-to-end delivery via WebSocket relay (with offline queue)
- JWS-signed public profile sync via HTTP service
- Encrypted group spaces using CRDT technology (Yjs default, Automerge option) with group key rotation
- CRDT-agnostic adapter architecture — swappable CRDT backends with identical API
- In-browser benchmark suite demonstrating 10-76x Yjs performance advantage over Automerge on mobile
- 534 passing tests across 6 packages, 7 end-to-end tests, 3 production services deployed
- Published npm packages: `@real-life/wot-core`, `@real-life/adapter-yjs`, `@real-life/adapter-automerge`

**What this funding will enable:**
- Authorization system (UCAN-inspired capability delegation)
- Social Recovery (Shamir Secret Sharing over verified contacts)
- Federated messaging integration (evaluating Matrix and Nostr as transport layers)
- Community pilot with real user groups
- Security audit of cryptographic primitives

**Expected outcomes:**
A production-ready, audited trust infrastructure that any community application can integrate — from cooperative platforms to local marketplaces to neighbourhood coordination tools — without depending on centralized platforms or corporate identity providers.

### Prior Experience

I am a full-time open-source developer based in Germany. I have been self-funding my work on community-oriented software and will continue to work on Web of Trust full-time if funded. My GitHub activity documents my ongoing contributions.

- **Utopia Map** — An open-source mapping platform for local initiatives and community resources, actively deployed and used by community groups in Germany.

- **Web of Trust** — Over the past 3 months, I have designed and implemented the complete architecture from scratch: 7 adapter interfaces, multiple CRDT backends (Yjs + Automerge), 534 tests (including 7 end-to-end tests), 3 deployed services (Relay, Vault, Profiles), and comprehensive documentation including a systematic evaluation of 16 frameworks, 6 DID methods, and detailed threat models. All self-funded.

- **Real Life Stack** — A modular UI component library for community applications, designed to work with Web of Trust as its identity and trust layer. Being developed in collaboration with a small team.

The current Web of Trust prototype demonstrates significant technical depth: framework-agnostic adapter architecture, deterministic key derivation with HKDF, ECIES encryption pattern without external dependencies, CRDT integration with group key management, and a blind WebSocket relay with SQLite-backed offline queuing.

**Why I build this:**

I believe something fundamental is shifting. More and more people feel that the way we live together is no longer working — and are searching for alternatives. At the same time, technologies are emerging that enable true decentralization for the first time: software that works without central servers, encryption that protects privacy, identity systems that no corporation owns.

I want to build these tools so they serve the people who are already walking new paths — in their neighbourhoods, gardens, and communities. Not as the next social network, but as infrastructure that belongs to the community.

**License:** AGPL-3.0 — ensuring that all modifications remain open, including server-side deployments. This aligns with the project's core principle: infrastructure that belongs to the community.

---

## Requested Support

### Amount

€50,000

### Budget Allocation

The project follows a phased development approach over approximately 12 months. Budget is allocated across 5 work packages:

**WP1: Authorization & Capability System (€10,000 — ~200h @ €50/h)**
- Extend existing AuthorizationAdapter (core is implemented: InMemoryAuthorizationAdapter + capabilities.ts)
- Capability delegation chains with full verification (read/write/delegate permissions)
- Space-level and item-level access control with revocation
- Persistent capability storage (currently in-memory only)
- Integration with Vault for capability backup
- Comprehensive test suite (target: 40+ additional tests)

**WP2: Social Recovery (€6,000 — ~120h @ €50/h)**
- Shamir Secret Sharing implementation for BIP39 seed recovery
- Recovery shard distribution over verified contacts
- Threshold configuration (e.g., 3-of-5 contacts needed)
- Recovery flow with verification checks
- User documentation and threat model update

**WP3: Federated Messaging Integration (€12,000 — ~240h @ €50/h)**
- Phase 1: Structured evaluation of Matrix vs. Nostr as production transport (both are viable candidates with different trade-offs — this deliberate evaluation is part of the process, similar to our systematic framework evaluation of 16 CRDT/messaging frameworks that informed the current architecture)
- Phase 2: Implement the selected protocol as a new MessagingAdapter
- Matrix: Megolm group E2EE, federation via homeservers, mature ecosystem
- Nostr: Lightweight relay architecture, growing ecosystem, simpler protocol
- Federation support (communities can run their own relay/homeserver)
- Migration path from current custom WebSocket relay
- Backward compatibility guaranteed through the existing MessagingAdapter interface

**WP4: Security Audit & Hardening (€15,000)**
- External security review of cryptographic implementations (Ed25519, X25519 ECIES, HKDF key derivation, AES-256-GCM)
- Penetration testing of relay and profile services
- Review of key derivation paths and seed storage security
- Privacy review (GDPR compliance assessment)
- Publication of audit results as open document

**WP5: Community Pilot & Documentation (€7,000 — ~140h @ €50/h)**
- Pilot deployment with 2-3 real community groups
- User onboarding materials (multilingual)
- Developer documentation and integration guides
- API documentation for adapter interfaces
- Contribution guidelines and governance model

**Total: €50,000**

### Other Funding Sources

No prior or current external funding. The project has been developed entirely through voluntary contributions and personal investment of time.

### Comparison

Web of Trust occupies a unique position in the landscape of decentralized identity and trust systems:

**vs. Solid / WebID:**
Solid focuses on data pods and linked data. Web of Trust focuses on trust relationships between people through real-world encounters. They are complementary — WoT could serve as a trust layer for Solid pods.

**vs. Keyoxide / OpenPGP Web of Trust:**
Keyoxide provides identity verification through cryptographic proofs linked to online accounts. Our Web of Trust requires in-person encounters for verification — a fundamentally different trust model that creates stronger, locality-based trust graphs.

**vs. Spritely / Object Capabilities:**
Spritely (by Christine Lemmer-Webber) uses object capabilities with OCAP patterns. We share the capability-based authorization philosophy but focus specifically on community-scale trust networks with BIP39 recovery, rather than general-purpose distributed computing.

**vs. Nostr:**
Nostr provides a lightweight relay-based messaging protocol with a growing ecosystem. Its use of secp256k1 differs from our Ed25519 stack, but bridging is possible. Nostr lacks in-person verification and structured trust graphs. We are evaluating Nostr as a potential messaging transport — our adapter architecture would add the trust layer on top.

**vs. Matrix:**
Matrix provides excellent federated messaging and E2EE (Megolm). However, it lacks a trust/verification layer based on real-world encounters. We are evaluating Matrix as a potential messaging transport — our adapter architecture would add the trust layer on top.

**vs. AT Protocol (Bluesky):**
AT Protocol depends on centralized DID:PLC infrastructure and focuses on social media. It does not provide in-person verification or encrypted group collaboration.

**vs. CRDT frameworks (Automerge, Yjs, Jazz, DXOS, Loro):**
These are local-first CRDT frameworks. We evaluated 16 of them systematically and designed a framework-agnostic adapter architecture rather than committing to a single one. We use Yjs as the default (pure JavaScript, 10-76x faster than WASM-based alternatives on mobile) with Automerge available as a swappable option. Our contribution is the trust and identity layer that all these frameworks lack.

**What makes Web of Trust unique:**
1. Trust based on real-world encounters (not online proofs)
2. Framework-agnostic adapter architecture (swap any component)
3. Single BIP39 seed derives all keys (identity, encryption, storage)
4. No dependency on centralized infrastructure
5. Designed for community-scale, not planet-scale

### Technical Challenges

1. **Key Management Across Devices:** Deriving deterministic keys from a single BIP39 seed across different browsers and environments while maintaining security. WebCrypto API availability and behavior varies. Our HKDF-based derivation path approach solves this architecturally, but ensuring consistent behavior and secure seed storage across environments requires careful implementation.

2. **Federated Messaging E2EE Bridge:** Integrating with an established messaging protocol (Matrix or Nostr) while maintaining our own E2EE guarantees. Matrix uses Megolm for group encryption, Nostr uses NIP-44 — both differ from our X25519 ECIES pattern. The challenge is maintaining our adapter abstraction while leveraging battle-tested transport protocols.

3. **CRDT Conflict Resolution with E2EE:** Our encrypt-then-sync pattern means CRDT merging happens on the client after decryption. This works across different CRDT backends (Yjs default, Automerge option — adapters are swappable), but creates challenges for concurrent edits when users are offline for extended periods — regardless of which CRDT engine is used.

4. **Social Recovery Security:** Implementing Shamir Secret Sharing requires careful threshold selection and shard distribution. The recovery process must verify that recovery contacts are still trusted (verifications haven't been revoked) and handle the case where contacts have lost their own keys.

5. **Capability Delegation Chains:** Implementing UCAN-like delegation where Alice grants Bob write access, and Bob can further delegate to Carol — while ensuring revocation propagates correctly in an offline-first, decentralized system without a central revocation list.

### Ecosystem Engagement

**Target Communities:**

1. **Local community groups in Germany** — Through the Utopia Map network, we are connected to community initiatives that need digital coordination tools but reject centralized platforms. Identifying and onboarding concrete pilot groups is an explicit goal of WP5 before the funding period ends.

2. **Open-source developers building community tools** — The npm package `@real-life/wot-core` is designed as a library that other developers can integrate. The adapter architecture makes it easy to add Web of Trust identity to existing applications.

3. **Complementary currency and cooperative economy initiatives** — Time banks, community currencies, and cooperative platforms all need decentralized trust infrastructure. Web of Trust provides the identity verification layer these systems require — without forcing them onto a centralized platform.

**Engagement Strategy:**

- **Dogfooding:** Our development team (4 people) uses the tools we build. Kanban board and calendar are the first Real Life Stack modules built on Web of Trust.
- **Pilot programs:** Deploy with 2-3 real community groups, gather feedback, iterate.
- **Developer outreach:** Publish integration guides, maintain npm package, present at local meetups and open-source conferences.
- **Documentation:** Comprehensive docs already exist (architecture decisions, threat models, protocol specifications). Will be expanded with user-facing guides.
- **Standards participation:** Engage with W3C DID working group and Fediverse standards discussions. Our work on did:key and adapter patterns has broader applicability.

---

## AI Disclosure

This application was drafted with the assistance of a generative AI system.

- **Model:** Claude (Anthropic), model ID: claude-opus-4-6
- **Date of use:** February 11, 2026
- **Purpose:** Structuring and drafting the application text based on existing project documentation, architecture documents, and implementation status. The AI read the project's technical documentation (CURRENT_IMPLEMENTATION.md, adapter-architektur-v2.md, architektur.md) and the applicant's memory/notes to produce a coherent application draft.
- **What was AI-generated:** The structure and prose of this document. All technical facts, architecture decisions, budget allocations, and strategic direction were provided by the applicant.
- **What was human-directed:** Fund selection (NGI Zero Commons Fund), budget amount (€50,000), all architectural decisions, technology choices, community strategy, and work package definitions.

The applicant reviewed, edited, and approved the final submission.

---

## Checklist Before Submission

- [ ] Email-Adresse eintragen
- [ ] Telefonnummer eintragen
- [x] Lizenz: AGPL-3.0 gewählt
- [x] LICENSE-Datei im Repository anlegen
- [ ] Budget-Aufstellung nochmal durchgehen
- [ ] Alle Work Packages realistisch?
- [ ] Messaging-Integration Scope prüfen (Matrix vs. Nostr vs. beide?)
- [ ] Team-Mitglieder fragen ob sie genannt werden wollen
- [ ] Anton: persönliche Note / Motivation ergänzen?
- [ ] Finale Version ins NLNet-Formular übertragen
