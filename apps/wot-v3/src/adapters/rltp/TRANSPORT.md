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
| stop | adapter → carrier | the generation ends |
| deposit | adapter → carrier | `submit` of one document handed over by `holder.handOver`, `withdraw` of one not taken |
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
   takes a digest once. A withdrawal the carrier refused stays owed and is tried again until it went
   through (a new deposit of the same digest cancels it). A deposit that threw may have begun: it is
   withdrawn like one the holder no longer names, and the hand-over comes again.
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
   lease that deposited it last, each state change in turn, until that lease stops; no other lease.
   Only that lease withdraws it: an opening that stops never withdraws what a later one deposited.
4. **Shutdown order.** New work is blocked and the generation ends (gate closed, lease deactivated,
   timers, subscriptions), on every path, also a close without a lock first → running hand-overs
   end, within a deadline → reception closes (the lease stops; what the carrier has not taken is
   withdrawn) → `await holder.close()` → the writer lock is released (host). A holder that did not
   close, also one of an opening whose build failed, keeps the opening registered, the lock held and
   the namespace taken; the next close or open of the namespace tries again. A receive arriving
   during shutdown is neither taken nor acknowledged: it is answered `later` and the carrier
   delivers it again.

## Replays (lib 0.6.1)

The lib's `replay(actId)` will re-run an act whose outcome is unknown. It does not enter here: a
replay is a holder act like any other, and what it commits reaches the carrier only through
`pendingTransport` and `handOver` under these rules. Where the session's `replayOpen` repeats
an act today, the replay will take its place.
