# adapters/rltp: library requirements and what is still to build

What `@real-life/trust-protocol` 0.9.0 lacks for the store app, from the architecture
(`store-launch-v3-architektur-2026-10-18.md`, §3.1 "Lib-Anforderungen"). "IIW" marks rows the
review rated as required for the IIW scope; the scope itself is Anton's decision (§11).

| Need | 0.9.0 | Required | IIW | Adapter fallback |
|---|---|---|---|---|
| 1:1 messages | `sendMessage`, `inbox`, `takeMessages`, `deliveryStatus` (Message Tasks 0.1) | — | yes | built: send with held drafts, sender status, inbox take-over |
| Messages without a loss gap | inbox in the holder state until `takeMessages` | — | yes | built: history written first, then `takeMessages` |
| Blocking | `block` / `unblock` in the holder state, `ContactView.blocked`, inbox `blocked` | — | yes | built: block plus pause as one intent, unblock clears both |
| Transport TSP Rev 3 | `./adapters/vti-mediator` (0.9.0): adapter, hints, send state, `readTrustTaskError`; the wire binding is dev-only in the repository | — | yes | built: `wire.ts` (the binding for the browser), `carrier-mediator.ts` (one adapter per carried relationship, TRANSPORT.md "The VTI mediator"); without a mediator `unconfiguredTransport` |
| Community anchor on a fresh holder | `trust` answers `no-community` on a holder without a personal community (Identity §5.4) | a way to found the personal community at setup | yes, for giving trust | `giveTrust` not offered (`not-supported`) |
| Outcome lookup without execution | re-running is the only way to an act's result | `holder.actOutcome(actId)`, read-only | no | `confirm-again`: `needs-confirmation` after a crash (built) |
| Encounter view | own open cards, sent cards, record → contact only in state and events | view of own open cards, sent cards, record → contactId | no | encounter cache from events (built), own optical captures map the sent card to its contact (built); a capture after the network bundle (network before optics) has no contact: the flow lands in `ready` with a hint, the decision is in the conversation |
| `recognized` at scan time | chaining comes later with continuity | — | no | the `recognized` outcome is reached only when the library reports `contact.chained` in the scan's commit |
| Encounter times in `ContactView` | only `tuples` | `metAt`, `lastMetAt` | no | from `encounter.recorded` / `contact.chained` in ingest (built); otherwise `null` |
| Atomic view bundle | each view reads its own snapshot | `holder.views({threads})` from one snapshot | no | fence on `profile().commitSeq` around the reads, applied mark in app-db (built) |
| Group messages | missing | fan-out to all members | with group chat | `groupMessaging = false` |
| Recipient snapshot for group reports | `GroupView.members` is the locally known roster | complete, versioned roster | with groups | reports are mail drafts (paper §6); no group report |
| Invitation context | group name only in internal state | `PromptView.context` for `group-invite` | no | `groupName = null` |
| Controlled retry of a terminal document | `resume` skips `failed` | human act `retryDocument(digest)` | no | "send as new message" |
| Role and own vouch in `GroupView` | no founder field | `role`, `pending[].vouchedBySelf` | no | `groupMeta` on intent completion |
| Decided prompts | `prompts()` only open | view of decided and expired prompts | no | own intent, else `unknown` (built) |
| Leave group, threshold > 1, candidacy | missing | membership exit, threshold change, option on accept | no | capabilities off |
| Pre-signed deregistration, carrier deregistration on delete | the VTI mediator keeps no registration of a did:key client (no keylist, profile Open Issue 5) | a carrier with registration (Delivery §5a.3) | no | `deregister` reports nothing registered |
| State copy at a storage service | missing | storage service | no | `restore` returns `keys-only` |
| Introductions | §8 of 0.31, 0.32 changes §8 | Guss 0.32 | no | `introduce: 'later'` |
| Multi-device | `addDevice`, one writer per holder | E15 | no | not in the port (§2.8) |

## Built in this adapter

`sealed.ts` (AES-GCM under the DEK), `store-idb.ts` (the library's Store port, CAS with a fresh
UUID per commit, sealable), `app-db.ts` (kv, intents, log), `gate.ts` (write gate), `transport.ts`
(interface, in-memory carrier, unconfigured transport), `wire.ts` (the VTI wire), `carrier-mediator.ts` (the VTI mediator as the device carrier),
`carrier-offer.ts` (N and the delivery hint of an encounter act), `ingest.ts` (pure derivation per sync),
`projection.ts` (pure bundle → read models), `acts.ts` (the human acts by command name),
`session.ts` (one opening: serial sync with fence, timers, transport, command service with the
intent journal and its recovery, the contact order of block and unblock in `CONTACT-ORDER.md`),
`host.ts` (HolderHost for the identity runtime),
`single-writer.ts` (Web Lock), `card-link.ts` (QR link format §5.3), `index.ts` (`createRltpPort`).

## Still to build

Replying (setting `replyTo`; received replies are shown), blocking anonymous group members, trust acts
(with the community anchor), groups, the diagnostic store wiring of `errors.ts`, store-family reference counting.
