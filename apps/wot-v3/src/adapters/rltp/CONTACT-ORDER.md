# Contact order: block and unblock

Applies to the acts with `ordered: true` in `acts.ts` (`block`, `unblock`) and to their part of the
command service in `session.ts`. Architecture §3.4, issue #425, paper "Nachricht als Trust Task" §7.

## Invariant

The last gesture the command service took on a contact sets the contact's target state. A partial
state (block without pause, unblock without resume) never exists without a running or a planned
completion.

"Taken" means journaled: the handle's `journaled` resolved `true`. A gesture refused before its
journal (locked, a failed journal write) was not taken and changes nothing.

## Section

Per contact one serial section (`section(target, …)`). It is entered **synchronously** when the
gesture is taken, so the order of the sections is the order of the gestures. One section holds the
whole handling, nothing of it runs outside:

1. **Dedupe**: read the open ordered records of the contact.
2. **Journal**: one write. The newest open record of the same gesture with the same input is
   reused (its actId, no new record); every other open ordered record of the contact ends as
   `done` with `refused/superseded`. Otherwise a new record (`journaled`) plus the ends of the older
   ones. After this write the gesture is taken.
3. **Parts**: two library acts under part ids `<actId>:block` + `<actId>:pause`, or
   `<actId>:unblock` + `<actId>:resume`. Each part first asks the library's act journal
   (`holder.replay`); a committed part answers from it, only a missing one runs. A first run and
   every recovery are the same call, so a part never runs twice under its actId.
4. **Finish**: the record `done` with its outcome, in one write.

Recovery of an ordered record (backoff timer, activation, network return, a new opening,
`retryIntent`) enters the same section and re-reads the record there: a record a newer gesture
superseded meanwhile is left alone; an open one gets steps 3 and 4.

At most one ordered record per contact is open after any journal write.

## Joining

While a gesture runs, the same gesture again (same dedupe key, same input) joins its handle, but
only if it is still the last gesture taken on the contact (`lastTaken`). Anything else enters a new
section behind the running one.

## Failures

| Where | Record | Next |
|---|---|---|
| journal write fails | unchanged (older records stay as they were) | gesture not taken; an older open record keeps its planned recovery |
| a part throws (storage) | `outcome-unknown`, attempts + 1 | recovery planned: 2 s, 10 s, 60 s, then every 60 s |
| a part is refused by the library | `done` with the refusal | none |
| finish write fails | stays open | recovery planned; the parts answer from the library's journal |
| gate closed (lock) | unchanged | the next opening completes it after its resume (`replayOpen`) |

## Deadline

Ordered records never expire. Past the manual limit (89 days) and past the library's retention
(90 days) recovery still completes them: these acts set a state on this device and send nothing, so
a part the library forgot runs again and sets the same state (Anton 21.10.: complete silently, no
question to the human). `expireOpen` skips them; `discardIntent` refuses them (a dropped record
would leave a partial state).

## Tests

`tests/crash/contact-order-interleavings.test.ts` holds every step above (dedupe, journal, each
part, finish; before and after), fails the journal and the pause or resume part, reopens the
session and lets the deadline pass while locked; it checks the invariant only from the library's
contact view, the intent journal and the library's act journal. `tests/rltp/review-422-r4.test.ts`
holds the two counter cases of #425.
