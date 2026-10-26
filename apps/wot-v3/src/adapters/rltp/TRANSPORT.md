# Transport adapter: contract with the carrier

Applies to `transport.ts` (`shareTransport`, its leases), to `carrier-mediator.ts` and `wire.ts` (the
VTI mediator, below) and to the transport part of `session.ts`. Delivery 0.84 RLTP-DEL-6120 to
RLTP-DEL-6135, lib 0.9.0 (`pendingTransport`, `handOver`, `close`, `./adapters/vti-mediator`), VTI
Mediator Adapter Profile 0.27, VTI 0.26 §1c (the displayed card's instance, RLTP-VTI-1250 to 1270).
The identity runtime's own completion contract is `../identity/LIFECYCLE.md`.

## Parties

- **Carrier**: the device's connection to its services. Two kinds: one that takes single documents
  (`Transport`: the in-memory carrier, the unconfigured transport), and the VTI mediator
  (`MediatorCarrier`), which takes the holder's custody view. Every call into a carrier may throw.
  Every answer from it may come late, twice, or through the handlers of an earlier start.
- **Adapter**: one **lease** per holder opening; the lease is all the session sees of the carrier. For a
  `Transport` the leases come from `shareTransport(carrier)` once per device (`kind: 'deposit'`: the
  session hands each document over and deposits it inside that step); the mediator gives its own
  (`kind: 'custody'`: the session hands it the view, the carrier hands each document over through the
  holder).
- **Holder**: keeps custody of every outbound document until a service took it or the holder gave
  it up (RLTP-DEL-6120). The adapter keeps no outbound store of its own.

## Callbacks

| Callback | Direction | What it is |
|---|---|---|
| connect | carrier → adapter | `status`: the network and the carrier's reachability |
| start | adapter → carrier | the device transport starts one generation |
| stop | adapter → carrier | the generation ends: `stop(registration)` names the handlers its start registered |
| deposit | adapter → carrier | `submit` of one document handed over by `holder.handOver`, `withdraw(deposits)` of the very objects submitted and not taken |
| receive | carrier → adapter | `envelope`: a document for this device |
| answer | carrier → adapter | `report`: the carrier's answer on a deposit |
| close | adapter → holder | `holder.close()` at the end of the opening |

## Rules

1. **The adapter never throws for good.** Every error and every uncertainty at any callback maps to
   one answer: `later` (not now, try again), with the reason in the diagnostics
   (`SharedTransport.faults()`). For a deposit `later` is `submit` returning false; for a receive it
   is the envelope answer `'later'`, so the carrier keeps the document and delivers it again; for
   start and stop it is a retry by the adapter; for connect it is the status `unknown`. Custody stays
   with the holder (RLTP-DEL-6120): the next cycle (a due time, the network coming back, the next
   activation or opening) hands the document over again. A deposit whose answer never arrived, came
   to an ended generation or could not be recorded goes over again at the next due time; the carrier
   takes a digest once. A withdrawal the carrier refused stays owed, bound to its deposit, and is
   tried again until it went through. A deposit that threw may have begun: it is withdrawn like one
   the holder no longer names, and the hand-over comes again. Every deposit of a digest the carrier
   has not taken is withdrawn, not only the last.
2. **Final answers only from a positive confirmation.** `accepted`, `delivered` and `failed(reason)`
   reach the holder only as the carrier's own report; `taken` and `not-mine` reach the carrier only
   as the holder's own answer to `receive` (`not-mine` only for a key this holder never issued; a
   `failed(rate-limited)` is transient and answered `later`, RLTP-DEL-5820). A fault never produces
   one of them.
3. **Every answer belongs to the generation it was computed for.** A generation is one start of the
   device transport for one opening in use; it ends at stop, at deactivation and at a switch of the
   opening in use. The handlers a generation gives the carrier act only while it is current: a report
   to an earlier generation has no effect, an envelope through it is answered `later`, and a receive
   whose generation ended while the holder worked is answered `later` too (the holder's receive is
   idempotent over the digest, the next generation answers it). Every report on a digest reaches the
   lease that deposited it last, each state change in turn, until `delivered` or until that lease
   stops (rule 6); no other lease.
   Only that lease withdraws it: an opening that stops never withdraws what a later one deposited.
4. **Shutdown order.** New work is blocked and the generation ends (gate closed, lease deactivated,
   timers, subscriptions), on every path, also a close without a lock first → running hand-overs
   end, within a deadline → reception closes (the lease stops; what the carrier has not taken is
   withdrawn) → `await holder.close()` → the writer lock is released (host). A holder that did not
   close, also one of an opening whose build failed, keeps the opening registered, the lock held and
   the namespace taken; the next close or open of the namespace tries again. A receive arriving
   during shutdown is neither taken nor acknowledged: it is answered `later` and the carrier
   delivers it again. The wait for running hand-overs (S2), the wait of a custody lease's `stop` for its
   ack state writes, and each attempt of `holder.close()` are bounded by 2 s of device time each
   (`DRAIN_LIMIT_MS`, `CLOSE_LIMIT_MS`); a close that did not return is a failed close under the
   paragraph above.

5. **Bound calls.** A carrier call that threw may still take effect, at any later time. Every call
   that ends or drops something therefore names its object: `stop` the registration of one start,
   `withdraw` the deposit objects of one `submit`. A carrier honours the binding: a late stop never
   ends a later registration, a late withdrawal never drops a later deposit of the same document.
   A confirmed stop or withdrawal also revokes what is still pending of its object: a start or a
   deposit that threw and would take effect later never does after that (a carrier maps each object
   to its registration or deposit id and honours the revocation until every call on it ended).
   A registration whose stop threw is stopped again until the carrier confirms; a new start does not
   wait for it. "Again" is `TRANSPORT_RETRY_MS` (1 s) of device time on the clock the adapter was given
   (`shareTransport(carrier, clock)`, #430): no wall-clock timer, a harness moves the clock instead of
   waiting. The in-memory carrier offers a transiently refused document again after `REDELIVER_MS` on
   its own clock (a carrier is a service of its own).

6. **One order of events per deposit.** Reports, withdrawals and the end of a duplicate's answer
   are events of one queue, handled one after another in the order they arrived: `accepted`,
   `delivered`, `failed`, `withdrawn`, `answer-ended`. What the carrier calls back while an event is
   handled (a report inside a withdrawal) is queued behind it and never overtakes it; every report
   reaches the holder in that order. A report names its deposit where the carrier knows it
   (`report(r, deposit)`): `failed` ends only that deposit, the others of the digest stay pending
   and are withdrawn when the holder lets the document go; `awaiting-transport` naming a deposit ends
   only that deposit (the carrier keeps no copy of it); `accepted` and `delivered` end every
   deposit of the digest (the carrier takes a digest once). The end of a duplicate's answer
   (its holder entry left the view by its own begun hand-over, Delivery 6330) is an event of its
   own, not a withdrawal: the deposit stays with the carrier until taken or until the opening
   stops. A deposit whose order ended (taken, failed, withdrawn) is no longer kept, not even as a
   withdrawal still owed. The routing of its digest is kept apart from the deposit: later reports
   reach the opening that deposited it last, until `delivered` or until that opening stops. After
   `accepted` a `delivered` is owed; after `failed` a late valid acknowledgement still turns the
   status `delivered` (Delivery §6.1), so `failed` ends the deposit, never the routing. `delivered`
   is final: nothing of the digest is routed after it.

   Every deposit has its own identity in its lease: the digest for a regular hand-over, `digest#n`
   for the answer to a duplicate (its number, `resend` in `pendingTransport`). The session decides
   the end of each identity on its own, and the lease's `withdraw` and `end` name identities, never a
   bare digest. The end of the regular retries of an acknowledgement (its entry leaves the view)
   withdraws only the regular deposits of the digest; a duplicate's answer whose hand-over began
   before or after that stays with the carrier until the carrier takes the digest, a failure names
   that answer, or the opening stops. A failure or an `awaiting-transport` naming one deposit,
   likewise, ends only it: the session lifts its re-offer lock, but keeps every identity it handed over
   until the holder no longer names it, and then withdraws or ends it at the lease.

## Acts with an open outcome

An act whose outcome is open (a crash, a lock, a lost answer) is settled by `holder.replay(actId,
when)` (lib 0.6.1), a pure read of the library's act journal, after a completed resume of the
opening: the journaled result is taken over; `unknown-act` means the act never committed or left the
journal, and nothing is sent blind (the message line says expired, "send as a new message"). Only an
act that never started runs. What an act committed reaches the carrier only through
`pendingTransport` and `handOver` under the rules above.

## The VTI mediator

`mediatorTransport({did, clock, network})` (`carrier-mediator.ts`) is the carrier of store builds:
`VITE_MEDIATOR_DID` names `C`, one per build, never per user; without it the web build runs the
unconfigured transport. The native store builds (fdroid, play, appstore) are refused by the store-build
check without it: their cards would carry no hint, and every relationship of their encounters would
stay uncarried for good (RLTP-VTI-1230, 1235). No workflow builds wot-v3 for a store yet; the
store-build workflow (with the cutover to `apps/demo`) must set it. Its custody lease runs, while its opening is in use, one
`MediatorCarrierAdapter` of the library per carried relationship, each over a wire of its own
(`wire.ts`): one session per relationship and side.

**Wire.** `wire.ts` is the binding of trust-protocol `binding/vti-wire.mjs` for the browser
(`@openvtc/vti-tsp-js` 0.3.0, `@openvtc/vti-didcomm-js` 0.12.0; only it imports them). It derives the
raw wire keys with the library's HKDF and info prefixes, so its DIDs are the adapter's trio. It
authenticates the connection DID (ATM) and opens one pickup socket (`globalThis.WebSocket`, the token
as subprotocol). A deposit is packed anew for every attempt in the mode the adapter names: `routed`
(inner TSP Rev 3 `direct` egress identity → the counterpart's connection DID, inside an outer routed
message connection DID → `C` with the route [counterpart's connection DID], sealed to the key `C`'s
DID document names at the last authentication or renewal, on the connection DID's socket) or
`egress-session` (the inner message alone, on a send-only session of the egress identity opened at
the first such deposit). Only a Rev 3 `direct` message with a payload, from the counterpart's egress
identity to this side's connection DID, reaches the adapter, byte for byte (RLTP-VTI-7140); every
other frame is acknowledged and reported to the diagnostics as `wire-frame-refused` with its kind,
never an identifier in the detail. The wire of a displayed card is the one exception until its binding
(below): it takes such a message from any sender and names the sender beside the detail, which the
carrier logs through the error filter. A frame is acknowledged when the adapter concludes it (the payload digest
translated to the mediator's queue id). A counterpart identity that is one of this side's own is
refused at construction (RLTP-VTI-1227). The quiet period of `queueEmpty()` and the reconnect backoff
(50 ms to 30 s) run on the device clock; `offline()` is the platform's network port. A socket that
closes is reopened in the background; a deposit or acknowledgement on a closed socket fails as
`unreachable`, never as a silent success. No reconnect is tried while the device is offline (the
network coming back resumes it) or while the access token has expired: then the socket waits for the
instance's renewal, `register` (the library's keylist intent), which authenticates through the wire
and reopens the socket with the new token; the instance's advance retries it until it lands. A side
that only receives so comes back after its token expired and its socket dropped. A socket that fails
after a valid authentication is a connection failure, never an authentication failure: the renewed
token stands and the reconnect backs off. No authentication is tried while the device is offline; one
that fails holds the next back with the reconnect's backoff (device clock), so a mediator that refuses
or a network that is gone costs no handshake per tick. A wire closed while its authentication runs
opens no socket afterwards. These rules are one session lifecycle (`sessionUnit` in `wire.ts`) for both
identities: the connection DID (pickup, live delivery, renewed by the adapter instance) and the egress
identity (send-only, opened and renewed by a deposit in `egress-session`); they differ only in the
session they build.

**Carried, not carried.** A relationship is carried when it has this side's carrier nonce N and its
counterpart's delivery hints read, as this side, to exactly one hint for `C` (`readDeliveryHints`,
RLTP-VTI-1225, 1227). Otherwise it is not carried (RLTP-VTI-1235): no instance, its documents stay in
the holder's custody, reported `awaiting-transport(transport-unreachable)` once per generation, and the
contact's details name the reason: the card had no hint, it named none readable for `C`, the stored ack
state was refused, or the build has no mediator. An instance whose build failed for a transient reason
(the store, a derivation) is planned again on the device clock, only while its generation runs; what
the failed build made is closed. A contact met without a carrier offer (no N) shows the reason "no
hint" while a mediator is configured. A contact's documents go through its first carried
relationship only (in the view's order); every carried relationship of the contact still receives.

**Delivery hints.** `show` and `scan` (the displayed card, the scanner's sent card) draw N, 32 bytes
of the entropy port, at the gesture and journal it with the act input (`carrier-offer.ts`); the act
builds the hint with `deliveryHint(root IKM, C, N)` (the 64-byte root IKM the identity hands the
opening, the same input as the adapter factory) and offers `{nonce, deliveryHints}` to the library,
which signs it into the card. A repeat under the same act id builds the same hint. Hints act at first
contact only (RLTP-VTI-1230). The displaying side learns the scanner's hint from the sent card in the
scanner's bundle, which reaches the instance of its displayed card over the mediator (below); the
optical leg of Encounter §5.8 is the way out without a network, never a step the encounter needs.
A displayed card's N moves from the show act's input into the opening's app-db (`displayed`, by
challenge, with its key and the instant its challenge was issued) in the transaction that finishes the
act; an entry whose challenge the holder resolves `unknown` leaves it at a timer of the opening at that
instant, or at the next opening or show.

**The displayed card's instance** (VTI 0.26 §1c, RLTP-VTI-1250 to 1270). The encounter is one scan:
A shows, B scans, B's bundle travels over the mediator, A confirms, the confirmation travels back.

- *Opening* (1250). A card displayed with an offer for `C` gets an instance of its own as soon as the
  show act finished (`lease.display`), and again at every opening, for as long as the holder resolves
  its challenge `open` (the N from `displayed`, the card's key and issue instant from the act's events):
  the library's adapter for the trio of the card's N, over a wire under the card's connection DID that
  knows no counterpart. It authenticates and opens its pickup socket like every instance; the card's
  key is the envelope's `rkid` of its bundle. "Open" is the library's own bound (Encounter 5190,
  `challengeAged`: past `issuedAt + CHALLENGE_MAX_AGE + SKEW_TOLERANCE`, whole seconds); the app sets
  no number of its own.
- *Before the binding* (1255, 1265). The wire hands the adapter the payload of a TSP Rev 3 `direct`
  message with a payload from any sender to the card's connection DID (the sender's did:key carries its
  key; an own identity is refused, 1227) and remembers the inner sender per frame. The three conditions
  of 1255 in their order: (1) the frame form, at the wire; (2) the holder's verdict on the envelope,
  which reaches the holder only sealed to the card's key (`receiveAtCard`), and the record of the card's
  challenge, the relationship whose carrier nonce is the card's N; (3) the holder takes it, `unique` or
  `duplicate-known`. A frame that fails (1) or is not sealed to the card's key is dropped before the
  holder; one the holder judges for good and records nothing for is concluded after its answer. Either
  way it is acknowledged at the mediator and logged (`carrier-card-frame-refused`) with its sender in
  short form (`did:key:z6Mk…xxxx`: the senders are told apart, no key is kept). A transient answer of
  the holder (`concludable` false: `failed(rate-limited)`, the one transient failure of Delivery 0.83,
  RLTP-DEL-5820) concludes nothing: the frame stays with the adapter and the mediator and is judged
  again (only a concludable refusal is acknowledged, 1265). A bundle after the
  challenge resolves `unknown` is the holder's `failed(validation-failed)`, a second scanner's bundle
  of the same card its `consumed-challenge`; a bundle the same counterpart issued anew is taken.
- *Binding* (1260). The instance binds at every record of its challenge, whichever way it came: a
  bundle through this carrier, through another carrier, or the optical capture (the contact view names
  a relationship with the card's N), at once, also while a collection of the instance runs. It binds
  to the identities the hint of the sent card names (`counterpartDeliveryHints` read for `C`, 1225,
  1227), never to the frame: the binding comes from the card's signature under the pair anchor, no
  trust on first use. A frame sender that is not the hint's egress identity is a diagnosis only
  (`carrier-hint-mismatch`, the sender in short form), never a refusal. The instance then is the
  relationship's instance: the same N, the same identities, the library's adapter runs on, its ack
  state is written under the relationship id from now on, and RLTP-VTI-7140 holds as for every other
  wire. Bound by its own bundle, the instance is ahead of the contact view until the session's next
  `carry`: it stays while the challenge is open and the view has not named its relationship yet (past
  the challenge end, a relationship the view never named closes like any other), and a card whose
  instance is bound gets no second one. A second bundle (the multi-scan of profile Open Issue 11) is refused in one of three ways: in
  the collection that bound the instance the carrier drops it (not the counterpart); arriving later the
  wire refuses it and acknowledges it; reaching the holder in the window between a record and its
  binding it is the holder's terminal `consumed-challenge`, concluded. A sent card that names no readable hint for `C` closes the instance (after
  the acknowledgement of the collection that found it went out, within the drain limit of device time,
  a wait the end of the generation cancels) and the relationship is not carried (1235).
- *Closing* (1270). An instance not bound when the holder resolves its challenge `unknown` closes:
  a timer on the device clock runs to the first instant the library's bound is past, then the
  library's predicate decides (one timer at the earliest end, cancelled with the generation,
  `LIFECYCLE.md`); it closes with every instance at deactivation and at the opening's close. Nothing
  more: a sender that gives up deletes nothing at the mediator, which keeps a frame until it is
  acknowledged.
- *Limits.* One session per displayed card while its challenge is open, up to
  `CHALLENGE_MAX_AGE + SKEW_TOLERANCE` (ten minutes in lib 0.9.0): a person who opens "Verify in
  person" again holds a socket per card shown within that time. Before the binding nothing of the
  instance is persisted: a frame concluded and not yet acknowledged when the process ends is offered
  again by the mediator and absorbed by the holder (`duplicate-known`). A crash between the holder's
  commit of a bundle and the binding leaves no diagnosis of the frame's sender: the next opening builds
  the relationship's instance from its hint as for any relationship, and the frame, never concluded,
  comes again and is absorbed. The multi-scan (several scanners of one card) is profile Open Issue 11:
  the first record binds, the others are refused as above.

**Counterpart error documents** (profile §5, RLTP-VTI-5010 to 5030). A counterpart refuses a
document with the registry's `trust-task-error/0.5`. The library reads one by its form
(`readTrustTaskError`: a terminal verdict with its code, `unsupportedVersion`, `permissionDenied`,
`cancelled` and `taskFailed` among them; a retry whose `retryAfter` binds the instance that took it
until the next opening and never past the give-up horizon; `idConflict` as an answer; `expired` as
nothing) and takes the verdict through `receiverRefused`, `receiverRetry` or `answered`. Validating
the document is the delivery layer's: its proof, its parties, and that it answers a document of this
side. This app applies no such verdict yet. The wire hands an error document to the adapter like any
payload (a Rev 3 `direct` message from the counterpart's egress identity, RLTP-VTI-7140); the carrier
hands it to the holder, which reads no error document and judges it for good: it is concluded and
acknowledged, and no own document changes (`tests/rltp/wire-counterpart-error-document.test.ts`). The
carrier cannot validate it alone: the envelopes it carries are sealed, so it knows no document `id`
an `inResponseTo` could name, and it verifies no proof of a foreign type. A refused document keeps
its state until its acknowledgement or its give-up horizon; the contact's delivery line shows no
receiver code from an error document. Applying the verdicts waits for the library (`TODO.md`).

**Sending form.** Every instance starts `routed`. It switches one way to `egress-session` when an open
routed deposit (an own document accepted in routed and not answered) is 72 h old, checked after a
conclusion that left nothing pending (`queueEmpty()`, RLTP-VTI-7150), or at once when the wire
refuses a deposit as `routed-refused` (RLTP-VTI-3130); there is no return to `routed`. Acknowledgements
are sending attempts and open nothing (profile Open Issue 9). A copy of a document that comes again
after the adapter's give-up horizon reaches the holder, which absorbs it and answers it with the
stored acknowledgement. The valid acknowledgements and refusals the holder verifies reach the
instances (`answered`) before the collection that carried them is concluded.

**Ack state.** Each instance's `ackState()` (concluded items, pending acknowledgements, the send
state) is written to the opening's app-db under `ack/<relationship id>` (sealed under the DEK) after
every change, and when the instance closes, and restored into the next instance of the relationship
with the restore instant. One relationship's reads and writes run in the order they were asked for: a
restore never reads behind a write. The holder state is the truth for answers, and the ack state
follows it: an instance restored from its ack state answers every open deposit the holder recorded
answered (delivered, or refused by the receiver; `deliveryStatus`) before its first advance, so a
crash between the holder's commit of an answer and the ack state write leaves no answered deposit
open and switches nothing; an answer the holder commits while an instance is being built is applied
to it before its first advance (each build its own, also when two builds of one relationship overlap
after a deactivation and activation). A deposit in a sending mode the store does not hold yet waits until the
write that holds it landed; if that write fails, the deposit is `later` (rule 1) and nothing goes out
in that mode, so a relationship never returns to a mode it left. A snapshot the library
refuses is never replaced by a fresh one (fail-closed): the relationship is not carried in that
opening, and the diagnostics record `carrier-ack-state-refused`.

**Chained relationship.** A relationship whose id appears in another relationship's `chainedFrom`
closes its instance, its ack state is deleted (also when no instance of it ran in the opening), and it
gets no successor (profile §6, RLTP-VTI-1230): the chain is carried by the instance of its first
contact.

**Instances.** At most one instance runs per relationship and per card N, and after `stop()` no
socket of the lease is open. Every build of an instance (a relationship's, a card's) has an identity
of its own, unique across generations; the marker that a relationship or a card is being built belongs
to that build: a build that ends removes only a marker that is still its own (a deactivation clears
the markers, the next generation sets its own, #438). A build's result is set in place only while its
generation runs and its slot (the relationship id, the card's N) has no instance; otherwise its adapter
and its wire are closed, and its socket never opened (it opens at the instance's admission).

**The rules against this carrier.** Rules 1 to 6 hold unchanged; here is how:

1. Every call into the adapter and the wire is caught. A failed attempt is the adapter's report
   `awaiting-transport` (the document stays in custody and goes again at the next hand-over); a
   receive that failed or answered `later` (rate-limited) leaves its frame unconcluded and
   unacknowledged, the mediator offers it again; a status the carrier cannot give is `unknown`.
2. `accepted` reaches the holder only from the adapter's report on a deposit the wire resolved;
   `delivered` and a refusal only from the holder's own check of the counterpart's answer; `failed`
   only from the adapter (its horizon, `oversize`); `taken` and `not-mine` only from the holder's
   receive.
3. A generation is one activation of the opening. Deactivation closes every instance (the library's
   `close`: retired, a late wire outcome changes nothing); a report is read only from instances of the
   current generation; a collection whose generation ended is not concluded.
4. Shutdown: deactivation closes the instances, the running hand-overs drain, `stop` awaits the ack
   state writes for at most `DRAIN_LIMIT_MS` of device time (a write that did not land is a loss the
   holder's state answers again at the next restore), then the holder closes. A wire call in flight cannot be recalled (profile §6): the
   copy that arrives is a duplicate the receiver absorbs.
5. Each instance and its wire are objects of their own: closing names the instance; a withdrawal is a
   reconcile without the entry, bound to its submission in the library.
6. Each submission's report is read from its instance and passed on when it changes, in the
   adapter's order; one document goes through one relationship.

The injection matrix `tests/crash/transport-mediator-*` (one seed per file, a vitest project of its own
that runs after the rest of the suite, two files at a time) checks these against the real adapter and the
real wire over the mediator double (`harness/mediator-double.ts`): the wire throws (before and after
the frame went out), a late answer (after the next step, after a lock to the next generation),
`routed-refused` (the switch across a process end), authentication down, an expired token, the socket
drops or is refused, offline, a frame twice, a receive answered rate-limited or failing, a card without
a hint or with one for another carrier, a chained relationship, the 72 h deadline on a mediator that
carries no routed frames; A's displayed card (seeds 14 to 16): the bundle that arrives over the
mediator (one scan), a foreign frame at the card, an optical record while a collection of the card
is held open (it binds at once), a second scanner of the card in each of its three
ways, a bundle of a scanner that was offline arriving past `CHALLENGE_MAX_AGE` (taken), the close when
the challenge resolves `unknown`, a kill with the card on display whose bundle the next process takes, and a kill between
the holder's commit of the bundle and the binding; overlapping builds of one card across two
generations (one instance, one socket, none after the end of the opening); a kill of the process (no shutdown) right after the holder committed an
answer, right after a routed refusal, with a deposit in flight, right after a receive before its
conclusion, each followed by 72 h of quiet in which an answered relationship must not switch; a side
that only receives with an expired token and a dropped socket; ten minutes of refused sockets (the
reconnects stay within the backoff); a renewal whose sockets keep failing (one handshake, no
handshake per tick); offline with an expired token (no request at all) and a mediator that refuses
every handshake (the requests back off); a switch whose write fails, then a kill (nothing in egress-session before the
store holds it, the restore is routed); a new generation right after a switch (the restore reads the
close's write). `tests/rltp/wire-*.test.ts` hold the wire's demultiplexing and the custody
lease on their own, `tests/rltp/wire-card.test.ts` the displayed card's instance; `e2e/mediator.spec.ts`
the two phones: one scan, and the optical way out without a network.

**Limits.** `accepted` means the frame went onto the socket: the mediator answers a deposit with no
acceptance of its own (trust-protocol `binding/README.md`, measured fact 5; the reference wire
resolves the same way). A frame lost in the socket's send buffer when the socket drops is reported
accepted and ends `failed` at the horizon; only the counterpart's signed acknowledgement closes the
trias. Token lifetimes are the mediator's clock, compared with the device clock: a device clock far
off renews too early or too late. Every carried relationship holds a socket of its own (two after the
switch); many contacts mean many sockets and handshakes at the start, not measured. A mediator that
refuses a token before its local expiry (a restart, a revocation) is answered by the reconnect's
backoff only: the renewal comes when the device clock reaches the token's expiry, so a side that only
receives can stay unreachable for up to one token lifetime. An open encounter record replays its card
with the `C` it journaled: after a build with another mediator that card names the old one.
`queueEmpty()` is the binding's approximation (an open socket quiet for 1 s), no answer of
the mediator. The wire ties no problem report of the mediator to a deposit, so the real binding never
reports `routed-refused` yet (profile Open Issue 4); the switch by the deadline is the path that runs.
A key change of `C` is seen at the next authentication or renewal. `didwebvh-ts` (inside
`vti-didcomm-js`) carries a lazy `node:fs` branch the build externalizes; the browser never takes it.

