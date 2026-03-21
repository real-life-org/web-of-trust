# User Stories

Complete list of user stories for the Web of Trust.

Implementation status is based on `docs/CURRENT_IMPLEMENTATION.md` (last updated 2026-03-15).

---

## Onboarding & Verification

| ID | As a... | I want to... | so that... | Priority | Status |
|----|---------|--------------|------------|----------|--------|
| O-01 | New user | be onboarded via a personal QR scan | I am admitted to the network | Must | DONE |
| O-02 | Existing user | verify new people at meetups | my network grows | Must | DONE |
| O-03 | User | see which contacts I have verified | I keep an overview | Must | DONE |
| O-04 | User | hide a contact | I no longer see their content | Should | DONE (excludedMembers) |
| O-05 | User | see who has verified me | I know how I entered the network | Could | NOT YET |

---

## Content & Collaboration

| ID | As a... | I want to... | so that... | Priority | Status |
|----|---------|--------------|------------|----------|--------|
| C-01 | User | share an event | I can invite people | Must | DONE (Spaces) |
| C-02 | User | mark a location on the map | I can meet others there | Should | NOT YET |
| C-03 | User | use the app without internet | the app works everywhere | Must | DONE (offline-first) |
| C-04 | User | see when the last sync happened | I know if everything is current | Should | DONE (debug panel) |
| C-05 | User | share content only with certain contacts | I can control my privacy | Could | DONE (item-keys, spaces) |
| C-06 | User | create shared projects/lists | we can collaborate | Could | DONE (Spaces / CRDT) |

---

## Attestations

| ID | As a... | I want to... | so that... | Priority | Status |
|----|---------|--------------|------------|----------|--------|
| A-01 | User | create an attestation for someone | their contribution becomes visible | Must | DONE |
| A-02 | User | see a person's attestations | I can assess what they can do | Must | DONE |
| A-03 | User | see my own attestations | I know my "profile" | Must | DONE |
| A-04 | User | tag attestations | they are filterable | Should | DONE (tags field) |
| A-05 | User | search by skills/tags | I find people with specific skills | Should | NOT YET |

---

## Security & Recovery

| ID | As a... | I want to... | so that... | Priority | Status |
|----|---------|--------------|------------|----------|--------|
| S-01 | User | store my recovery phrase securely | I can restore my key | Must | DONE (BIP39 + encrypted seed) |
| S-02 | User | understand what happens if I lose my key | I know the consequences | Must | DONE (onboarding flow) |
| S-03 | User | export my data | I am not locked in | Should | NOT YET |
| S-04 | User | use the app on multiple devices | I am flexible | Could | DONE (multi-device sync via Relay + Vault) |
| S-05 | User | see which devices have access | I control security | Could | NOT YET |

---

## Priority Legend

- **Must:** Core functionality — app is not usable without it
- **Should:** Important for good UX, but not critical
- **Could:** Nice-to-have, for later versions

## Status Legend

- **DONE:** Implemented and tested
- **NOT YET:** Planned but not yet implemented

---

*See also: [Personas](personas.md) for user profiles*
