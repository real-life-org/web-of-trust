# adapters/rltp: library requirements

What `@real-life/trust-protocol` 0.4.0 lacks for the store app, from the architecture
(`store-launch-v3-architektur-2026-10-18.md`, §3.1 "Lib-Anforderungen"). "IIW" marks rows the
review rated as required for the IIW scope; the scope itself is Anton's decision (§11).

| Need | 0.4.0 | Required | IIW | Adapter fallback |
|---|---|---|---|---|
| 1:1 messages | missing | trust task for messages: document type, sender signature, receive effect, triad via outbox | yes | `capabilities.messaging = false`, composer locked |
| Messages without a loss gap | events are not replayed; `receive` is no human act | received message document kept in a holder-state inbox; view `inbox(since)`; non-human act `ackInbox(digests)` | yes | no message receipt in a store version |
| Transport TSP Rev 3 | `binding/vti-wire.mjs` is dev-only | published transport package (wire, mediator session, `./adapters/vti-mediator`), carrier registration per relationship | yes | transport interface; in-memory transport only for loopback |
| Reporting | missing | disclosure document with selected signed messages, sealed to the moderation inbox; in groups also to members | yes | none |
| Blocking: drop deliveries | missing | block set in holder state; receive drops documents of blocked counterparts | yes (whether `block: 'local'` suffices is open) | `untrust` + `pauseTrust` + local list |
| Group messages | missing | fan-out to all members, sender signed as member anchor | with group chat | `groupMessaging = false` |
| Recipient snapshot for group reports | `GroupView.members` is the locally known roster | complete, versioned roster | with groups | `groupRoster.coverage = 'known-only'` |
| Outcome lookup without execution | re-running is the only way to an act's result | `holder.actOutcome(actId)`, read-only | no | `confirm-again`: `needs-confirmation` after a crash |
| Invitation context | group name only in internal state | `PromptView.context` for `group-invite` | no | `groupName = null` |
| Controlled retry of a terminal document | `resume` skips `failed` | human act `retryDocument(digest)` | no | "send as new message" |
| Twelve words → root IKM (Identity §4) | `seedKeys` checks only ≥ 32 bytes | `rootIkmFromMnemonic(words)` with vectors | no | `@scure/bip39` `mnemonicToSeed(words, '')` + vector test |
| Atomic view bundle | each view reads its own snapshot | `holder.views({threads})` from one snapshot | no | fence procedure with `appliedCommitSeq` |
| Encounter view | own open cards, sent cards, record → contact only in state and events | view of own open cards, sent cards, record → contactId | no | `encounterCache` from intent completions |
| Encounter times in `ContactView` | only `tuples` | `metAt`, `lastMetAt` | no | from own acts; otherwise `null` |
| Role and own vouch in `GroupView` | no founder field; `pending` without "vouched by me" | `role`, `pending[].vouchedBySelf` | no | `groupMeta` on intent completion |
| Decided prompts | `prompts()` only open | view of decided and expired prompts | no | journal, events, else `unknown` |
| Leave group | no command | membership exit | no | `leaveGroup = false` |
| Vouch threshold > 1 | `threshold-unsupported` | threshold change | no | found with 1 |
| Show candidacy, read own candidacy | `decide` has no options | option on accept; view of the running admission | no | `candidacyVisibility = false` |
| Pre-signed deregistration on wipe | deregistering needs the relationship keys | transport package produces signed deregistrations | no | deregister in phase S3 with a deadline |
| Carrier deregistration on identity delete | in the transport package | deregister per relationship | with the transport package | best effort, reported in `WipeReport.remote` |
| State copy at a storage service (Identity 6.3, §9.3) | missing | storage service, recovery context | no | `restore` returns `keys-only` |
| Introductions | §8 of 0.31, 0.32 changes §8 | Guss 0.32 | no | `introduce: 'later'` |
| Multi-device | `addDevice`, one writer per holder | E15, multi-writer contract, setup flow with device id | no | not in the port (§2.8) |

## Adapter modules still to build (architecture §3.1)

`runtime.ts`, `gate.ts`, `store-idb.ts`, `single-writer.ts`, `projection/{ingest,collect,project,publish}.ts`,
`app-db.ts`, `message-log.ts`, `local-lists.ts`, `command-service.ts`, `transport/`, `mnemonic.ts`,
`commands/`. `errors.ts` (the ActError table) exists.
