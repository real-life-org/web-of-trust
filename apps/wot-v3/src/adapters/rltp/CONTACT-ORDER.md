# Contact order: block, unblock, trust, pause, the classes

Applies to the acts with `ordered: true` in `acts.ts` (`block`, `unblock`, `giveTrust`,
`withdrawTrust`, `setPaused`, `setClass`) and to their part of the command service in `session.ts`.
Architecture §3.4, issue #425, paper "Nachricht als Trust Task" §7.

## Lanes

Each ordered act names its **lane** (`acts.ts` `lane(input)`): the part of the contact's state it
sets. `block` and `unblock` share the lane `block`; `giveTrust` and `withdrawTrust` the lane `trust`;
`setPaused` has `pause`; `setClass` one lane per class (`class:<cls>`). Supersession and the
one-open-record rule hold per contact **and lane**: only a gesture of the same lane covers an older
one's target state. An open record of another lane is not a competitor; a new gesture completes it
first, in the same section, before its own attempt (review 483 B1).

## Invariant

Per lane, the last gesture the command service took on a contact sets that part of the contact's
target state. A partial state (block without pause, unblock without resume) never exists without a
running or a planned completion.

"Taken" means journaled: the handle's `journaled` resolved `true`. A gesture refused before its
journal (locked, a failed journal write) was not taken and changes nothing.

## Section

Per contact one serial section (`section(target, …)`). It is entered **synchronously** when the
gesture is taken, so the order of the sections is the order of the gestures. One section holds the
whole handling, nothing of it runs outside:

1. **Dedupe**: read the open ordered records of the contact, those of the gesture's lane apart.
2. **Journal**: one write. The open record of the same gesture with the same input in the lane is
   reused (its actId, no new record); every other open record of the lane ends as `done` with
   `refused/superseded`. Otherwise a new record (`journaled`) plus the ends of the older ones. After
   this write the gesture is taken. The open records of the other lanes then get their attempt,
   oldest first, before step 3.
3. **Parts**: two library acts under part ids `<actId>:block` + `<actId>:pause`, or
   `<actId>:unblock` + `<actId>:resume`. Each part first asks the library's act journal
   (`holder.replay`); a committed part answers from it, only a missing one runs. A first run and
   every recovery are the same call, so a part never runs twice under its actId.
4. **Finish**: the record `done` with its outcome, in one write.

Recovery (backoff timer, activation, network return, a new opening, `retryIntent`) is per contact
and enters the same section. There it reads the contact's open ordered records, one per lane, the
last gesture taken in each, and gives them steps 3 and 4, oldest first. A record a newer gesture
superseded is left alone.

At most one ordered record per contact and lane is open after any journal write.

## Invalid journal

Several open ordered records of one lane never arise under this contract, and the app never
shipped a journal written without it (no migration code). At opening, before any recovery, every
lane with more than one open ordered record has all of them dropped from the journal; nothing of
them runs, the library state stays as it is, and the diagnostic store gets one entry with the code
`contact-order-invalid-journal` and no content (no contact, no input). The entry reaches the store
only once the opening is the one in use; an opening a lock overtook records nothing. A failed drop
aborts the opening; the next opening drops. Recovery meeting such records
during a session drops them the same way.

## Joining

While a gesture runs, the same gesture again (same dedupe key, same input) joins its handle, but
only if it is still the last gesture taken on the contact (`lastTaken`). Anything else enters a new
section behind the running one.

## Failures

| Where | Record | Next |
|---|---|---|
| journal write fails | unchanged (older records stay as they were) | gesture not taken; an older open record keeps its planned recovery |
| a part throws (storage) | `outcome-unknown`, attempts + 1 | recovery planned: 2 s, 10 s, 60 s, then every 60 s (failed attempts per contact in this opening; a finished record resets them and cancels the planned recovery) |
| a part is refused, the contact exists | `outcome-unknown`, attempts + 1 (a part may be done, the other missing) | recovery planned as above |
| a part is refused with `unknown-contact` | `done` with the refusal | none: no contact, no state to complete |
| finish write fails | stays open | recovery planned; the parts answer from the library's journal |
| gate closed (lock) | unchanged | the next opening completes it after its resume (`replayOpen`) |

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

`tests/crash/contact-order-interleavings.test.ts` holds every step above (dedupe, journal, each
part, finish; before and after), fails the journal and the pause or resume part, reopens the
session and lets the deadline pass while locked, also while a recovery is planned on the clock
(after every lock no timer of the ended opening is left); it checks the invariant only from the library's
contact view, the intent journal and the library's act journal. `tests/rltp/review-422-r4.test.ts`
holds the two counter cases of #425, `tests/rltp/review-422-r5.test.ts` refusals, finish failures and a
dedupe read held across a reopening, `review-422-r5`/`-r6` the invalid journal, `review-422-r8` (#428) the timers at lock, after a failed
opening and a timer of an ended opening that fires anyway, plus a `gc-only` probe that the locked
opening's holder is collectible before its planned recovery was due.
