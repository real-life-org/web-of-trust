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

```
git show 13893fb:docs/nlnet-application-2026.md
```

Key content of the initial draft:
- 5 Work Packages totaling €50,000
- WP2 based on Shamir Secret Sharing
- Referenced Automerge as CRDT (pre-Yjs migration)
- 182 tests, 2 deployed services
- Single npm package (`@web.of.trust/core`)
- AI Disclosure section included

### Applicant Edits After Interaction 1

Minor formatting and wording adjustments. No structural changes at this stage.

---

## Interaction 2 — Update During Documentation Consolidation (2026-03-15)

### Context

Between Interaction 1 and 2, the project underwent significant technical changes: migration from Automerge to Yjs as default CRDT (76x faster on mobile), package separation (adapter-yjs, adapter-automerge), test count grew from 182 to 534, 3rd service (Profiles) deployed, 7 end-to-end tests added.

### Prompt

> Update the NLNet application to reflect the current state. We now have 534 tests, 7 E2E tests, Yjs as default CRDT, Automerge as option, 3 deployed services, and published npm packages @web.of.trust/core, @web.of.trust/adapter-yjs, @web.of.trust/adapter-automerge. Update test counts, CRDT references, service count, and npm packages. Also update WP1 to reflect that AuthorizationAdapter core is already implemented.

### Unedited Output

The AI updated the existing application with current numbers and technology references. Committed as part of `b69f51e` (2026-03-15). The full output is preserved in git history:

```
git show b69f51e:docs/nlnet-application-2026.md
```

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

The AI generated a complete rewrite (222 lines) incorporating all of the above direction. The full output is the current version of the file:

```
docs/nlnet-application-2026.md
```

Key changes in this rewrite:
- Budget: €50,000 → €31,000
- 4 Work Packages (down from 5): Authorization €8k, Recovery €8k, DX €5k, Community €10k
- WP2: Shamir → Guardian-based recovery using the trust network
- WP4 (Community Pilot) has the largest budget — signaling commitment to adoption
- "Why I build this": personal motivation, concrete problem (communities depending on corporate infrastructure)
- Developer-first framing: "npm install @web.of.trust/core"
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

## Summary

| Interaction | Date | Purpose | Scope |
| --- | --- | --- | --- |
| 1 | 2026-02-11 | Initial draft | Full application, 5 WPs, €50k |
| 2 | 2026-03-15 | Factual update | Numbers, technology names |
| 3 | 2026-03-16 | Major rewrite | New scope, 4 WPs, €31k, complete restructuring |

All outputs are preserved in git history or as the current file. Full conversation logs are available on request.

**What was AI-generated:** Structure, prose, and formatting of the application text.

**What was human-directed:** Fund selection, all architecture decisions, technology choices, budget amounts, work package definitions, scope decisions, team composition, community strategy, and the decision to reduce scope based on team feedback.
