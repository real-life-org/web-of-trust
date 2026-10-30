# Contact order: block, unblock, trust, pause, the classes

Applies to the acts with `ordered: true` in `acts.ts` (`block`, `unblock`, `giveTrust`,
`withdrawTrust`, `setPaused`, `setClass`) and to their part of the command service in `session.ts`.
Architecture §3.4, issue #425, paper "Nachricht als Trust Task" §7, review 483 rounds 1 to 3.

## Lanes

Each ordered act names its **lanes** (`acts.ts` `lanes(input)`): the parts of the contact's state
it sets, the class settings of Trust 2810 and the block, every effect the act has. `giveTrust` and
`withdrawTrust` set `anchorMapping`; `setPaused` sets `star` and `groupStar`; `block` and `unblock`
set `block`, `star` and `groupStar` (the pause is part of the block); `setClass` sets its class.

## Invariant

A taken gesture stays binding for every part of the state it sets until it ran, or until a newer
gesture replaced all of those parts. Per part, the last gesture taken sets the target state. A
partial state (block without pause, pause without the groupStar) never exists without a running or
a planned completion.

"Taken" means journaled: the handle's `journaled` resolved `true`. A gesture refused before its
journal (locked, a failed journal write) was not taken and changes nothing.

## Queue

Per contact the open ordered records form one queue, in the order the gestures were taken. The
order is the record's `seq`: greater than every open record of the contact when it was journaled
(a timestamp would not tell two gestures of one millisecond apart). Live handling and every
recovery use the same order. Records written before 3.0.4 have no `seq` and come first.

A newer gesture **supersedes** an older open record only when its lanes cover the older one's
whole: then every part the older one would set is set by the newer one anyway, and the older
one's pending obligation is replaced (a `setClass anchorMapping` covers a `giveTrust`, a
`setPaused` a `setClass star`, an `unblock` a `block`). Only the obligation is replaced: what the
older one's library act already committed stands and is overwritten by the newer one's act. A
record the newer gesture covers only in part, or not at all, stays ahead of it in the queue.

## Section

Per contact one serial section (`section(target, …)`). It is entered **synchronously** when the
gesture is taken, so the order of the sections is the order of the gestures. One section holds the
whole handling, nothing of it runs outside:

1. **Dedupe**: read the contact's open ordered records, in queue order.
2. **Journal**: one write. The same gesture with the same input at the end of the queue is reused
   (its actId, no new record); otherwise a new record (`journaled`, next `seq`) plus the end of every
   older record it covers, as `done` with `refused/superseded`. After this write the gesture is
   taken.
3. **Queue ahead**: every open record ahead of it gets its attempt (step 4), oldest first. One that
   stays open holds the rest: the gesture is taken, open, waits behind it; its handle's `done`
   answers `infra/unknown-outcome` (retryable), and the planned recovery of the record ahead carries
   the whole queue.
4. **Attempt**: the library act under the record's actId (`block` and `unblock`: two acts under part
   ids `<actId>:block` + `<actId>:pause`, or `<actId>:unblock` + `<actId>:resume`; each part first
   asks the library's act journal, `holder.replay`, and only a missing one runs). A first run and
   every recovery are the same call, so an act never runs twice under its actId.
5. **Finish**: the record `done` with its outcome, in one write.

Recovery (backoff timer, activation, network return, a new opening, `retryIntent`) is per contact
and enters the same section. There it reads the contact's queue and gives every record steps 4
and 5, oldest first; one that stays open holds the rest, with the next recovery planned.

## Invalid journal

Open ordered records of one contact whose order cannot be told (the same `seq`, or two without
one) were not written under the contract; the app never shipped a journal written without it (no
migration code). At opening, before any recovery, every such set has all of them dropped from the
journal; nothing of them runs, the library state stays as it is, and the diagnostic store gets one
entry with the code `contact-order-invalid-journal` and no content (no contact, no input). The
entry reaches the store only once the opening is the one in use; an opening a lock overtook
records nothing. A failed drop aborts the opening; the next opening drops. Recovery meeting such
records during a session drops them the same way. Several open records of one contact are no
longer invalid by themselves: they are the queue.

## Joining

While a gesture runs, the same gesture again (same dedupe key, same input) joins its handle, but
only if it is still the last gesture taken on the contact (`lastTaken`). Anything else enters a new
section behind the running one.

## Failures

| Where | Record | Next |
|---|---|---|
| journal write fails | unchanged (older records stay as they were) | gesture not taken; an older open record keeps its planned recovery |
| the act throws (storage) | `outcome-unknown`, attempts + 1 | recovery planned: 2 s, 10 s, 60 s, then every 60 s (failed attempts per contact in this opening; a finished record resets them and cancels the planned recovery); the queue behind it waits |
| the act is refused with a transient code (`errors.ts` `TRANSIENT_REFUSALS`: the library could not write its log, a device log behind) | `outcome-unknown`, attempts + 1 | recovery planned as above; the queue behind it waits |
| a later part is refused after an earlier one committed (`acts.ts` `PartialRefusal`: a block without its pause) | `outcome-unknown`, attempts + 1 | recovery planned as above; the queue behind it waits (the invariant: no partial state without a planned completion; the pinned library refuses no pause or resume) |
| the act is refused for good (every other case, `unknown-contact` among them) | `done` with the refusal | none: a refusal is the library's answer to this state, a repeat would get the same; the queue moves on, the human sees the refusal |
| finish write fails | stays open | recovery planned; the act answers from the library's journal, no second act |
| gate closed (lock) | unchanged | the next opening completes the queue after its resume (`replayOpen`) |

## Timers

A planned recovery is a timer of the opening (`LIFECYCLE.md`, register): the end of the opening
(lock, switch, delete) and a failed opening cancel it with every other timer and drop the
reference, so a closed opening's holder is not kept until the timer is due. A timer of an ended
opening that fires anyway does nothing. The open record stays in the journal; the next opening
completes it after its resume (`replayOpen`), with the backoff starting again at 2 s.

## Deadline

Ordered records never expire. Past the manual limit (89 days) and past the library's retention
(90 days) recovery still completes them: these acts set a state on this device and send nothing, so
a part the library forgot runs again and sets the same state (Anton 21.10.: complete silently, no
question to the human). `expireOpen` skips them; `discardIntent` refuses them (a dropped record
would leave a partial state).

## Tests

`tests/rltp/contact-order-queue.test.ts` holds the matrix of the queue: the lanes of two gestures
independent, covering whole, or overlapping in part; the older one failing in the library's store
(lasting into the retry the newer one triggers); completed live and after a reopening; plus a
failure after a committed part (the block's pause), a finish lost between the library's commit and
the journal, and a final refusal that does not hold the queue.
`tests/crash/contact-order-interleavings.test.ts` holds every step above (dedupe, journal, each
part, finish; before and after), fails the journal and the pause or resume part, reopens the
session and lets the deadline pass while locked, also while a recovery is planned on the clock
(after every lock no timer of the ended opening is left); it checks the invariant only from the library's
contact view, the intent journal and the library's act journal. `tests/rltp/review-422-r4.test.ts`
holds the two counter cases of #425, `tests/rltp/review-422-r5.test.ts` a transient refusal, finish
failures and a dedupe read held across a reopening, `review-422-r5`/`-r6` the invalid journal
(records without `seq`), `review-422-r8` (#428) the timers at lock, after a failed opening and a
timer of an ended opening that fires anyway, plus a `gc-only` probe that the locked opening's holder
is collectible before its planned recovery was due. `tests/rltp/trust.loopback.test.ts` holds the
trust acts in the queue (review 483 B1, rounds 1 to 3).
