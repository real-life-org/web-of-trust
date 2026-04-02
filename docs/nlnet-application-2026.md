# NLNet NGI Zero Commons Fund — Application

**Fund:** NGI Zero Commons Fund
**Deadline:** April 1, 2026, 12:00 CEST
**Note:** This application was drafted with the assistance of Claude (Anthropic, Opus 4.6). See AI Disclosure at the end.

---

## Contact Information

- **Name:** Anton Tranelis
- **Email:** mail@antontranelis.de
- **Phone:** +49 176 41556543
- **Organisation:** (none — applying as individual)
- **Country:** Germany

---

## General Project Information

### Proposal Name

**Web of Trust — Decentralized Identity and Trust Infrastructure**

### Website / Wiki

https://web-of-trust.de

### Abstract

Web of Trust is decentralized digital social infrastructure that puts data sovereignty at its center. It provides self-sovereign identity, mutual verification, signed attestations, and end-to-end encrypted collaboration — as an open JavaScript library any developer can integrate.

Today, communities that want to coordinate locally depend on corporate platforms they don't control. Decentralized protocols solve messaging, data sync, and identity — but none provide a trust layer based on mutual verification and reputation. Web of Trust fills this gap.

A working prototype exists: identity (did:key, Ed25519), mutual verification via QR code, encrypted group spaces (Yjs/Automerge), offline support, published npm packages, and a live demo. Funding will enable access control, guardian-based identity recovery using the trust network itself, developer documentation, and a community pilot with real user groups.

The outcome is production-ready commons infrastructure for community applications — belonging to the community, not to a company.

### Prior Experience

I am a full-time open-source developer, self-funding my work on community-oriented software. I initiated and lead both projects listed below.

- **Utopia Map** — An open-source mapping platform for local initiatives and community resources, with 860 registered users and ~50 map instances deployed by community groups across Germany. https://github.com/utopia-os/utopia-map

- **Real Life Stack** — Modular, backend-agnostic UI toolkit for community apps: calendars, maps, marketplaces. Web of Trust is the first integration. https://github.com/antontranelis/real-life-stack

**License:** MIT

---

## Requested Support

### Amount

€36,000

### Budget Allocation

The project follows a phased development approach over approximately 9 months (720h total, ~80h/month). Budget is allocated across 4 work packages:

**WP1: Authorization & Access Control (€10,000 — ~200h @ €50/h)**

- Extend existing AuthorizationAdapter (core is implemented: InMemoryAuthorizationAdapter + capabilities.ts)
- Space-level and item-level access control: read, write, admin permissions
- Revocation of permissions
- Persistent capability storage and replication across devices
- Integration with Vault for capability backup and distribution to space members
- Comprehensive test suite

**WP2: Identity Recovery & Key Rotation (€10,000 — ~200h @ €50/h)**

- Guardian-based recovery using the existing Web of Trust network
- User creates new DID, verified contacts confirm identity through signed attestations
- Configurable threshold (e.g., 3-of-5 guardians must confirm)
- Protections against social engineering
- Key rotation as voluntary variant of the same mechanism
- DID migration: attestations and verifications transfer from old to new DID via equivalence proofs
- This approach is unique to Web of Trust: the guardian network exists naturally from in-person verifications — no artificial setup required

**WP3: Developer Experience & Documentation (€6,000 — ~120h @ €50/h)**

- Optimize the library for ease of integration: simplify API surface, provide sensible defaults, reduce boilerplate required to get started
- Getting-started guide, integration examples, and tutorials
- API reference for all 7 adapter interfaces
- Contribution guidelines and governance model

**WP4: Community Pilot (€10,000 — ~200h @ €50/h)**

- Stabilize reference application (based on Real Life Stack) for pilot deployment — calendar, marketplace, map modules built on Web of Trust
- Onboard 2-3 pilot groups from our network of local community initiatives
- Target: at least 30 users completing in-person verification during the pilot
- User onboarding materials (multilingual)
- Gather feedback, iterate, document lessons learned
- Explore alternative verification methods beyond QR codes to lower adoption barriers

**Total: €36,000**

**Team:** Sebastian Stein (frontend/UX, Real Life Stack) and Tillmann Heigel (infrastructure, native mobile apps) contribute actively but their work is outside this application's scope. We are considering a separate application for the Real Life Stack in the next funding round.

### Other Funding Sources

No prior or current external funding. The project has been developed entirely through voluntary contributions and personal investment of time.

### Comparison

Web of Trust occupies a unique position in the landscape of decentralized identity and trust systems:

**vs. OpenPGP Web of Trust:**
The classic PGP Web of Trust established the concept of decentralized trust through key signing. However, it remained a tool for technical users, required manual key management, and never achieved mainstream adoption. Our Web of Trust builds on the same philosophical foundation but with a modern approach: 12 words to write down instead of PGP key files to manage, automatic key derivation, QR-code verification flows designed for non-technical users, and encrypted collaboration built in.

**vs. CRDT frameworks (Automerge, Yjs, Jazz, DXOS, Loro):**
These are local-first CRDT frameworks for data synchronization. Some include their own identity systems (Jazz has CoID accounts, DXOS has HALO), but none provide a trust layer with mutual verification between people. We evaluated 16 of them systematically and built a CRDT-agnostic adapter architecture with swappable backends — currently supporting both Yjs and Automerge. Our contribution is the trust layer — mutual verification, signed attestations, guardian recovery — that none of these frameworks provide.

**vs. Messaging protocols (Nostr, Matrix):**
Both provide messaging infrastructure but lack a trust layer based on direct mutual verification. Our adapter architecture is designed so that either could serve as a messaging transport — adding the trust layer on top.

**vs. Solid / WebID:**
Solid focuses on data pods and linked data. Web of Trust focuses on trust relationships through direct mutual verification. They are complementary — WoT could serve as a trust layer for Solid pods.

**vs. Keyhive:**
Keyhive provides group key agreement and invites for local-first data. We address a complementary problem: establishing trust between people through mutual verification before they collaborate. Our GroupKeyService handles group encryption today; Keyhive's approach could be integrated as a future upgrade path for more sophisticated group key management.

**vs. NextGraph:**
NextGraph provides a comprehensive local-first framework with Graph CRDT (RDF), DID support, and built-in E2EE. We are in contact with NextGraph's maintainer and see strong potential for collaboration — NextGraph's Graph CRDT is a natural fit for modeling trust relationships. Our CRDT-agnostic adapter architecture makes NextGraph integration realistic as a future backend.

**What makes Web of Trust unique:**

1. **Trust through mutual verification** — the protocol uses deliberate friction (mutual QR-code exchange) to encourage real encounters, but does not technically enforce physical presence. Trust is built through direct human interaction, not online proofs or algorithmic scores
2. **Reputation through signed attestations** — verifiable claims about skills, contributions, and collaboration — building organic reputation over time
3. **CRDT-agnostic adapter architecture** — swap any of the 7 components independently
4. **Guardian recovery via the trust network** — your verified contacts are your recovery network. No secrets shared, no server backup.
5. **Servers are blind** — Relay and Vault see only encrypted bytes, never plaintext. Profiles is public but under user control.
6. **Designed for local action** — optimized for communities that coordinate and collaborate in the real world

### Technical Challenges

1. **Guardian-Based Identity Recovery:** Using the trust network itself for recovery — verified contacts confirm a new DID via signed attestations. The challenge is ensuring that the recovery threshold is secure against social engineering while remaining accessible when genuinely needed. Key rotation and DID migration must preserve existing attestations and verifications through equivalence proofs.

2. **CRDT Conflict Resolution with E2EE:** Our encrypt-then-sync pattern means CRDT merging happens on the client after decryption. This works across different CRDT backends (adapters are swappable), but creates challenges for concurrent edits when users are offline for extended periods.

3. **Access Control in Offline-First Systems:** Implementing space-level and item-level permissions (read/write/admin) where revocation must propagate correctly without a central authority — in an offline-first, decentralized system where users may be disconnected when permissions change.

4. **Key Management Across Devices:** Deriving deterministic keys from a single BIP39 seed across different browsers and environments while maintaining security. Our HKDF-based derivation path solves this architecturally, but ensuring consistent behavior and secure seed storage across environments requires careful implementation.

**On security:** We have conducted an internal security review (threat model, crypto inventory, key derivation documentation) and use established cryptographic libraries (WebCrypto API, @noble/ed25519) rather than custom implementations. A formal external security audit is intentionally not part of this application — it would exceed the scope and budget of this funding round. We would welcome the opportunity to discuss a dedicated security audit with NLNet.

### Ecosystem Engagement

**Developers building decentralized software**

Web of Trust is infrastructure — a JavaScript library that developers integrate into their applications. The npm packages (`@web_of_trust/core`, `@web_of_trust/adapter-yjs`) provide self-sovereign identity, mutual verification, encrypted collaboration, and trust attestations as composable building blocks. Any developer building local-first, decentralized, or community-oriented software can add a trust layer without building their own identity system.

**Communities building decentralized trust networks**

Web of Trust is commons infrastructure for any community that wants to establish trust without depending on corporate platforms — neighbourhood initiatives, cooperatives, local exchange networks, transition towns. The community pilot (WP4) ensures we build the right thing: good infrastructure is shaped by real usage, not just technical correctness. Through Utopia Map (860 users, ~50 community instances) we already have direct access to some communities.

**Engagement Strategy:**

- **Developer outreach:** Publish integration guides, maintain npm packages, present at open-source conferences
- **Dogfooding:** Our team uses the tools we build. Real Life Stack is the first application built on Web of Trust.
- **Pilot programs:** Deploy with 2-3 real community groups, gather feedback, iterate
- **Documentation:** Comprehensive English documentation already exists (architecture, threat models, protocol specifications). Will be expanded with developer-facing guides and tutorials.
- **Standards participation:** Engage with W3C DID working group and local-first community. Our work on did:key, adapter patterns, and CRDT benchmarking has broader applicability.

---

## AI Disclosure

This application was drafted with the assistance of Claude (Anthropic, model: claude-opus-4-6) via Claude Code (CLI tool). Claude was used for structuring and writing — all technical decisions, architecture choices, budget allocations, and strategic direction are the applicant's. The application went through multiple revisions incorporating feedback from team members (Sebastian Stein, Tillmann Heigel). The applicant reviewed, edited, and approved the final submission.

A detailed prompt provenance log documenting all AI interactions is maintained separately: [nlnet-prompt-provenance-log.md](nlnet-prompt-provenance-log.md)

---

## Checklist Before Submission

- [x] Contact information filled in
- [x] License: MIT
- [x] LICENSE file in repository
- [x] Budget allocation reviewed (€36k, 4 WPs)
- [x] Work packages realistic and focused
- [x] AI Disclosure with prompt provenance log
- [ ] Final review
- [ ] Transfer to NLNet submission form
