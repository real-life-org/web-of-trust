# adapters/rltp: library requirements and what is still to build

What `@real-life/trust-protocol` 0.5.0 lacks for the store app, from the architecture
(`store-launch-v3-architektur-2026-10-18.md`, §3.1 "Lib-Anforderungen"). "IIW" marks rows the
review rated as required for the IIW scope; the scope itself is Anton's decision (§11).

| Need | 0.5.0 | Required | IIW | Adapter fallback |
|---|---|---|---|---|
| 1:1 messages | `sendMessage`, `inbox`, `takeMessages`, `deliveryStatus` (Message Tasks 0.1) | — | yes | adapter work: messages step |
| Messages without a loss gap | inbox in the holder state until `takeMessages` | — | yes | adapter work: messages step |
| Blocking | `block` / `unblock` in the holder state, `ContactView.blocked`, inbox `blocked` | — | yes | adapter work: report-and-block step |
| Transport TSP Rev 3 | `binding/vti-wire.mjs` is dev-only | published transport package (wire, mediator session, `./adapters/vti-mediator`), carrier registration per relationship | yes | `unconfiguredTransport` (documents wait before the trias); in-memory carrier only for loopback |
| Community anchor on a fresh holder | `trust` answers `no-community` on a holder without a personal community (Identity §5.4) | a way to found the personal community at setup | yes, for giving trust | `giveTrust` not offered (`not-supported`) |
| Outcome lookup without execution | re-running is the only way to an act's result | `holder.actOutcome(actId)`, read-only | no | `confirm-again`: `needs-confirmation` after a crash (built) |
| Encounter view | own open cards, sent cards, record → contact only in state and events | view of own open cards, sent cards, record → contactId | no | encounter cache from events (built); `already-captured` has no contact, the flow lands in `ready` with a hint |
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
| Pre-signed deregistration, carrier deregistration on delete | in the transport package | — | with the transport package | `deregister` reports nothing registered |
| State copy at a storage service | missing | storage service | no | `restore` returns `keys-only` |
| Introductions | §8 of 0.31, 0.32 changes §8 | Guss 0.32 | no | `introduce: 'later'` |
| Multi-device | `addDevice`, one writer per holder | E15 | no | not in the port (§2.8) |

## Built in this adapter

`sealed.ts` (AES-GCM under the DEK), `store-idb.ts` (the library's Store port, CAS with a fresh
UUID per commit, sealable), `app-db.ts` (kv, intents, log), `gate.ts` (write gate), `transport.ts`
(interface, in-memory carrier, unconfigured transport), `ingest.ts` (pure derivation per sync),
`projection.ts` (pure bundle → read models), `acts.ts` (the human acts by command name),
`session.ts` (one opening: serial sync with fence, timers, transport, command service with the
intent journal and its recovery), `host.ts` (HolderHost for the identity runtime),
`single-writer.ts` (Web Lock), `card-link.ts` (QR link format §5.3), `index.ts` (`createRltpPort`).

## Still to build

Messages (send, inbox take-over, delivery status), report and block, trust acts (with the
community anchor), groups, `markRead`/unread counts, the TSP transport, the scanner implementations
(platform step), automatic replay backoff (replays run once per unlock today), the diagnostic store
wiring of `errors.ts`, store-family reference counting.
