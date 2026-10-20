# Identity runtime: ownership and completion contract

Applies to `runtime.ts`, `lifecycle.ts` and `resources.ts`. Architecture §2.1 rules 7 and 9, §4.2
(boot matrix, restore, delete S1 to S6), §5.

## Modules

- `lifecycle.ts`, the coordinator: one epoch counter and one lane. Every port step of the identity
  runtime is a **transition** that runs in the lane. `lock` and `boot` end the epoch.
- `resources.ts`, the register: every holder opening and every secret byte buffer belongs to a
  **lease**. A lease belongs to the session, to the pending setup or restore, or to the call that
  acquired it.
- `runtime.ts`: the port steps, composed from both.

## Types

```ts
type Ticket = { epoch: number }                     // handed to a transition at its start
type Kind = 'session' | 'storage'                   // what lock does to a running transition
type OpeningState = 'active' | 'closing' | 'closed' // one holder opening in the register
type Lease = { ns; role: 'session' | 'pending' | 'call'; holder: Opening | null; secrets; released }
```

## Coordinator

| Request while the lane holds | same key, joinable | other transition | `lock` | `boot` |
|---|---|---|---|---|
| nothing, or a session transition of an ended epoch | runs | runs | runs | runs |
| a session transition of this epoch | joins it | `unavailable/in-flight` | ends the epoch, lane free | ends the epoch, takes the lane |
| a storage transition | joins it | `unavailable/in-flight` | revokes, does not wait | waits, then runs |
| `boot` | joins it | `unavailable/in-flight` | joins boot | joins boot |

- **Session transitions** wait on the vault, the biometric prompt or the holder and may install,
  open or publish a session: `unlock.*`, `setup.initHolder`, `activate`, `switchTo`,
  `finishRestore`, `protection.*`, `acceptTerms`. A session transition whose epoch ended reports
  `locked` (or `failed` for the outcome types), never success, whatever its body returned.
- **Storage transitions** write the vault or wipe: `boot`, `setup.reserve`, `writeVault`,
  `keystoreFirst`, `keystoreAfter`, the undo steps, `wipeOld`, `verifyOld`, `delete.*`,
  `legacy.*`. A lock does not end them; what they acquire still goes through the register.
- Joinable keys: `boot`, `unlock.open`, `activate`, `switchTo`, `finishRestore`, `delete.quiesce`
  to `delete.wipe`. Steps that carry a secret argument never join.

## Lock (synchronous before the first await)

0. `host.deactivate()`: no opening is in use any more (commands, publications, reception end at once).
1. End the epoch: the running session transition loses the lane and every right to commit.
2. Detach session and pending: their leases are released, nobody can reach them as a session again.
3. `unlocked` or `other-writer` becomes `locked` at once, with the lock info known for the namespace.

Then, asynchronously: close what the leases held, retry every opening left `closing` by an earlier
failure, refresh the lock info if nothing was published meanwhile. A failure there never changes the locked state and never rejects `lock()`. A second lock
joins the outstanding cleanup. A lock during `boot` joins `boot`.

`boot` does steps 1 and 2 synchronously as well, then runs the boot matrix in the lane.

## Register

- `adopt(lease, handle)`: a fresh opening becomes `active` in the lease. If the lease was released
  meanwhile, the opening goes straight to `closing`; it never becomes part of a session.
- `move(from, to)`: handover (pending to session, call to session) moves the opening and the
  secrets; the source no longer reaches them.
- `release(lease)`: synchronously `active → closing`, then the phases not done yet (quiesce, seal)
  and `close`, serialized per opening. Closed only after `close` returned; a failure leaves the
  opening `closing`, registered and reachable by `retry`. A failed quiesce or seal does not skip
  the close. The secret bytes of the lease are overwritten after the attempt, whether or not the
  host failed; a lease without an opening overwrites them at once.
- `retry(ns?)`: closes every `closing` opening again; an attempt still running is joined, not
  repeated. `settled(ns)` waits for running close attempts; `unlock.open` and `initHolder` wait for it before opening the same namespace.
- A transition's own call lease is released when the transition ends: whatever it acquired and did
  not hand over is closed and overwritten.

## Effects

A stale result after a write does not take the write back. Therefore every platform write of a
session transition (vault, keystore: `setProtection`, `rewrap`, `setBioUnusable`, `activate`,
`setResume`, `store`, `remove`) goes through `effect(t, lease, write)`. The check runs right before
the write starts: the ticket is current and the lease the write acts for (session or pending) is
held. Otherwise the write does not start and the step reports `locked` (or `failed`). A write that
needs the proven secret gets a copy taken from the held session (`withProven`), overwritten when the
write returns, so a lock that wipes the session during the write cannot change what it writes.
Reads (`head`, `open`, `availability`) need no check; what they return goes through the register.

A step that ends the session outside lock and boot (`delete.close`, `wipeNamespace` of the session's
namespace) does what lock does with the state, unless delete S1 froze the session.

## One completion contract

| Path | What happens |
|---|---|
| lock, boot | detach, release, retry; state as above |
| a late answer (vault open, retrieve, host open) after a lock | the bytes or the opening land in the call lease or in a released lease and are closed; the call reports `locked` |
| restore switch | old holder quiesced and sealed, `rec.switch`, then old session and new session swap without an await, old lease released; the opening becomes the one in use through `host.activate` when the identity is published unlocked on it (finishRestore, before the marker is removed: a failed removal leaves the identity in use and the marker for the next start, and finishRestore reports `infra/storage`: the flow shows "almost done" with a retry, never "done"); a host never promotes an opening on its own |
| activate, switch | pending's opening and keys move to the new session lease; the rest of pending is released |
| delete S1 | the session is frozen: it publishes nothing any more |
| delete S2, S3, S4 | phases on the active opening of the session, serialized with any release |
| unlock while a delete is resumed | the holder opens `dereg-only`: no transport, no timers, no intent recovery, nothing submitted; it never becomes the opening in use |
| an opening shuts down (lock, switch, delete) | the holder keeps custody of every outbound document, regular or acknowledgement, until a service took it or the holder gave it up (Delivery 0.83 RLTP-DEL-6120 to 6135, lib 0.6.0); the app keeps no outbound store. One transport lease per opening: it hands over only entries of `holder.pendingTransport` after a completed resume of that opening, each through `holder.handOver` (check and start of the send in one step of the holder's queue), and only while the opening is the one in use. At shutdown the lease withdraws what the carrier has not taken, and `await holder.close()` ends the opening (in quiesce, awaited again in close) before the store closes, before the writer lock is released and before the next opening of the namespace starts; the next opening hands over again what the holder still names. A refused hand-over never fails an activation; another namespace never sends it, the wipe removes it with the holder store |
| delete S5 | session and pending released, every `closing` opening retried; a host failure returns `infra/storage` (retryable) and the next `delete.close` retries the same opening |
| delete S6, verify | `wipeNamespace` releases and retries first; an opening of the namespace still registered is a survivor (`holder:<ns>`), so a delete never reports success with something open; a clean verification calls `host.wiped(ns)`, the host's signal that the delete is over (the real adapter keeps its single-writer lock until then) |

Storage steps that were already sent are not undone by a lock; the boot matrix finishes them.
During a delete the state stays as the delete found it until `delete.finish`; the flow owns the
screen.
