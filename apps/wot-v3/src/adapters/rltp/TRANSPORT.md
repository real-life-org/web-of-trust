# Transport adapter: contract with the carrier

Applies to `transport.ts` (`shareTransport`, its leases) and to the transport part of `session.ts`.
Delivery 0.83 RLTP-DEL-6120 to RLTP-DEL-6135, lib 0.6.0 (`pendingTransport`, `handOver`, `close`).
The identity runtime's own completion contract is `../identity/LIFECYCLE.md`.

## Parties

- **Carrier** (`Transport`): the device's connection to its services (TSP, the in-memory carrier,
  the unconfigured transport). Every call into it may throw. Every answer from it may come late,
  twice, or through the handlers of an earlier start.
- **Adapter**: `shareTransport(carrier)` once per device, and one **lease** per holder opening. The
  lease is all the session sees of the carrier.
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
   delivers it again. The wait for running hand-overs (S2) and each attempt of `holder.close()` are
   bounded by 2 s of device time (`DRAIN_LIMIT_MS`, `CLOSE_LIMIT_MS`); a close that did not return is
   a failed close under the paragraph above.

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
