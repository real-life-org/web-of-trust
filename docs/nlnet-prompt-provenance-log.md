# NLNet Application — Prompt Provenance Log

As required by [NLNet's Generative AI Policy](https://nlnet.nl/foundation/policies/generativeAI/), this document logs all generative AI interactions used in preparing the NLNet NGI Zero Commons Fund application.

**Model:** Claude Opus 4.6 (Anthropic), model ID: `claude-opus-4-6`
**Tool:** Claude Code (CLI), running locally
**Applicant:** Anton Tranelis

---

## Interaction 1 — Initial Draft (2026-02-11)

### Prompt

> Write an NLNet NGI Zero Commons Fund application for the Web of Trust project. Read the project documentation (CURRENT_IMPLEMENTATION.md, adapter-architektur-v2.md, architektur.md). Budget: €50,000. 5 Work Packages:
>
> - WP1 Authorization/UCAN (€10k)
> - WP2 Social Recovery/Shamir (€6k)
> - WP3 Federated Messaging/Matrix or Nostr (€12k)
> - WP4 Security Audit (€15k)
> - WP5 Community Pilot & Docs (€7k)
>
> License: AGPL-3.0. Applying as individual from Germany.

### Unedited Output

The AI generated a complete application draft (218 lines) based on the project documentation. This was committed to the repository on 2026-02-16 as part of commit `13893fb`. The full unedited output is preserved in the git history:

[View on GitHub](https://github.com/antontranelis/web-of-trust/blob/13893fb/docs/nlnet-application-2026.md)

Key content of the initial draft:
- 5 Work Packages totaling €50,000
- WP2 based on Shamir Secret Sharing
- Referenced Automerge as CRDT (pre-Yjs migration)
- 182 tests, 2 deployed services
- Single npm package (`@web_of_trust/core`)
- AI Disclosure section included

### Applicant Edits After Interaction 1

Minor formatting and wording adjustments. No structural changes at this stage.

---

## Interaction 2 — Update During Documentation Consolidation (2026-03-15)

### Context

Between Interaction 1 and 2, the project underwent significant technical changes: migration from Automerge to Yjs as default CRDT (76x faster on mobile), package separation (adapter-yjs, adapter-automerge), test count grew from 182 to 534, 3rd service (Profiles) deployed, 7 end-to-end tests added.

### Prompt

> Update the NLNet application to reflect the current state. We now have 534 tests, 7 E2E tests, Yjs as default CRDT, Automerge as option, 3 deployed services, and published npm packages @web_of_trust/core, @web_of_trust/adapter-yjs, @web_of_trust/adapter-automerge. Update test counts, CRDT references, service count, and npm packages. Also update WP1 to reflect that AuthorizationAdapter core is already implemented.

### Unedited Output

The AI updated the existing application with current numbers and technology references. Committed as part of `b69f51e` (2026-03-15). The full output is preserved in git history:

[View on GitHub](https://github.com/antontranelis/web-of-trust/blob/b69f51e/docs/nlnet-application-2026.md)

Key changes in this update:
- Test count: 182 → 534, added 7 E2E tests, 3 services
- CRDT: "currently Automerge" → "Yjs default, Automerge option"
- Added CRDT-agnostic adapter architecture description
- Added in-browser benchmark suite reference
- Updated npm packages list (3 packages)
- WP1: noted that AuthorizationAdapter core is already implemented
- Updated framework evaluation count: 8 → 16

### Applicant Edits After Interaction 2

No additional edits at this stage — the update was factual (numbers, technology names).

---

## Interaction 3 — Major Rewrite (2026-03-16)

### Context

Team member Sebastian Stein provided detailed feedback on the application. The applicant discussed scope, budget, and strategy with the AI over an extended session. Multiple back-and-forth exchanges led to a complete rewrite.

### Applicant Direction (summarized from multi-turn conversation)

Interaction 3 was a multi-turn conversation (~50 messages) where the applicant directed scope, budget, and framing decisions iteratively. The full transcript is available on request as a JSONL file. Below is a faithful summary of the applicant's direction:

> Incorporate Sebastian's feedback. Specifically:
>
> 1. Rewrite "Why I build this" — more personal, less manifesto
> 2. Remove WP3 (Federation) — too risky, our Relay works fine
> 3. Remove WP4 (Security Audit) — €15k is not enough for a real audit, ask NLNet for guidance instead
> 4. Replace Shamir Secret Sharing with guardian-based recovery using the trust network itself
> 5. Primary audience is developers building decentralized software, not communities directly
> 6. Add timeline with Q1/Q2/Q3 milestones
> 7. Reduce budget from €50k to around €30k
> 8. Add sustainability section
> 9. Shorten AI disclosure
> 10. "Commons infrastructure" as a thread throughout
> 11. Profiles server is NOT blind — it's a public discovery service under user control
> 12. WP1: Focus on space/item access control (read/write/admin), no capability delegation
> 13. More budget for community work (WP4)
> 14. Mention Sebastian Stein as team member
> 15. Add Utopia Map metrics (860 users, ~60 instances)
> 16. Define "community" clearly: local real-world communities, not online
> 17. Mention Real Life Stack as first application built on WoT

### Unedited Output

The AI generated a complete rewrite (222 lines) incorporating all of the above direction. Committed as `653f461` (2026-03-16). The full output is preserved in git history:

[View on GitHub](https://github.com/antontranelis/web-of-trust/blob/653f461/docs/nlnet-application-2026.md)

Key changes in this rewrite:
- Budget: €50,000 → €31,000
- 4 Work Packages (down from 5): Authorization €8k, Recovery €8k, DX €5k, Community €10k
- WP2: Shamir → Guardian-based recovery using the trust network
- WP4 (Community Pilot) has the largest budget — signaling commitment to adoption
- "Why I build this": personal motivation, concrete problem (communities depending on corporate infrastructure)
- Developer-first framing: "npm install @web_of_trust/core"
- Added: sustainability, security section, accessibility mention
- Added: timeline with quarterly milestones
- AI Disclosure shortened to 3 lines + reference to this log

### Applicant Edits After Interaction 3

The applicant reviewed the output and directed additional small corrections:
- Profiles server described as public (not blind)
- WP1 scope narrowed (no capability delegation)
- WP4 budget increased to €10k
- Total adjusted to €31k

These corrections were made through further AI interaction within the same session, with the applicant directing each specific change.

---

## Interaction 4 — Refinements (2026-03-27)

### Context

Continued review of the application. The applicant directed corrections and improvements based on their knowledge of the ecosystem and NLNet's requirements.

### Applicant Direction (summarized from multi-turn conversation)

> 1. Package names updated: @real-life/* → @web_of_trust/* (npm organization renamed)
> 2. Website URL: github.com → web-of-trust.de
> 3. CRDT comparison corrected: some frameworks (Jazz, DXOS) do include identity — our unique contribution is trust based on real-world encounters, not identity per se
> 4. Don't position Yjs as "default" — we support both Yjs and Automerge equally
> 5. Comparison section: remove Spritely (too different), remove AT Protocol (irrelevant for NLNet), merge Nostr + Matrix into one entry
> 6. Add NLNet-funded projects to comparison: Keyhive (group key agreement), NextGraph (Graph CRDT, in contact with maintainer)
> 7. Add "Reputation through signed attestations" to unique features
> 8. "Designed for local communities" → positive framing: "Designed for local action"
> 9. Add "Real change happens in real life" to motivation section
> 10. WP1: add "replication across devices" and "distribution to space members"
> 11. Budget adjusted to €33,000 (WP1: €10k, WP2: €8k, WP3: €5k, WP4: €10k)
> 12. Real Life Stack described as "backend-agnostic" — not exclusive to WoT

### Unedited Output

Changes were made incrementally through individual edits, not as a single generation. Each change was directed by the applicant and applied as a targeted text replacement. Committed as `1c20f29` (2026-03-27). The full output is preserved in git history:

[View on GitHub](https://github.com/antontranelis/web-of-trust/blob/1c20f29/docs/nlnet-application-2026.md)

---

## Interaction 5 — Team Feedback Integration (2026-03-30)

### Context

Team members Tillmann Heigel and Sebastian Stein reviewed the application and provided detailed feedback. Sebastian additionally ran an AI review to generate structured criticism. The applicant worked through all feedback points with Claude Code in a single session.

### Applicant Direction (summarized from multi-turn conversation)

> Incorporate feedback from Tillmann and Sebastian:
>
> 1. Abstract must fit 1200 character limit (was ~3600) — less technical, more core idea
> 2. Sebastian and Tillmann mentioned as team in budget section, explicitly out of scope
> 3. Budget: WP2 increased from 160h to 200h (Tillmann: "too low"), total now €35k
> 4. Budget inconsistency fixed (checklist said €28k, body said €33k)
> 5. Security audit moved to Technical Challenges — too expensive for this round, discuss with NLNet in future round
> 6. "real-world encounters" reduced throughout — Tillmann correctly noted the protocol doesn't enforce physical presence, only encourages it through deliberate friction
> 7. Keyoxide comparison replaced with OpenPGP Web of Trust (Keyoxide is inactive)
> 8. WP4 pilot targets made concrete: 2-3 groups, 30 users
> 9. Developer vs. Community framing tension addressed
> 10. Prompt provenance log removed from application, linked as separate document
> 11. Timeline and Sustainability sections removed (not in NLNet form fields)
> 12. Instance count fixed: 50 everywhere (was 50 vs 60)
> 13. Consider RLS application in next funding round

### Unedited Output

Changes were made incrementally through individual edits directed by the applicant. Committed as `ece5352` (2026-03-30). The full output is preserved in git history:

[View on GitHub](https://github.com/antontranelis/web-of-trust/blob/ece5352/docs/nlnet-application-2026.md)

---

## Interaction 6 — Final Review & Submission Prep (2026-03-31)

### Context

Final session before submission. The applicant reviewed the application once more, made targeted improvements, and ran a simulated NLNet reviewer assessment.

### Applicant Direction (summarized from multi-turn conversation)

> 1. WP3 budget increased from 100h/€5k to 120h/€6k — add API surface optimization, not just documentation. Total now €36k.
> 2. OpenPGP comparison: "BIP39 seed phrases" → "12 words to write down" (more accessible language)
> 3. Security: moved from numbered Technical Challenge #5 to separate paragraph ("On security:") — it's a scope decision, not a technical challenge
> 4. Simulated NLNet reviewer perspective: identified and fixed budget inconsistency in checklist (€36k), validated all character limits
> 5. Abstract: "Decentralized protocols solve messaging" → "solve messaging, data sync, and identity" (more accurate)
> 6. Verified all 6 form fields are within NLNet character limits
> 7. License changed from AGPL-3.0 to MIT — maximizing adoption over copyleft protection, based on discussion with Sebastian Galek (see his article [Die Open Source Falle](https://www.sebastiangalek.de/posts/2026/die_open_source_falle/)). Updated LICENSE file, README, NLNet application, and HMC integration concept.

### Unedited Output

Changes were made incrementally through individual edits directed by the applicant. Key commits (2026-03-31):

- [Application updates](https://github.com/antontranelis/web-of-trust/blob/5b52eb5/docs/nlnet-application-2026.md)
- [License change AGPL → MIT](https://github.com/antontranelis/web-of-trust/commit/98ed9ae)

---

## Summary

| Interaction | Date | Purpose | Scope |
| --- | --- | --- | --- |
| 1 | 2026-02-11 | Initial draft | Full application, 5 WPs, €50k |
| 2 | 2026-03-15 | Factual update | Numbers, technology names |
| 3 | 2026-03-16 | Major rewrite | New scope, 4 WPs, €31k, complete restructuring |
| 4 | 2026-03-27 | Refinements | Package names, comparisons, framing, budget €33k |
| 5 | 2026-03-30 | Team feedback | Abstract shortened, budget €35k, framing improved |
| 6 | 2026-03-31 | Final review | WP3 increased, language polish, budget €36k, license AGPL→MIT, submission prep |

All outputs are preserved in git history. Complete conversation logs for all interactions are attached as JSONL files alongside this application.

**What was AI-generated:** Structure, prose, and formatting of the application text.

**What was human-directed:** Fund selection, all architecture decisions, technology choices, budget amounts, work package definitions, scope decisions, team composition, community strategy, and the decision to reduce scope based on team feedback.
