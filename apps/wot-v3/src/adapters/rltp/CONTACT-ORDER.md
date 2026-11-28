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
`retryIntent(actId)` answers for that record (#484): its attempt's result, `infra/unknown-outcome`
while it waits behind a record that stayed open, `refused/superseded` once it is no longer open.

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
| the act is refused with a transient code (`errors.ts` `TRANSIENT_REFUSALS`: the library could not write its log, a device log behind) | `outcome-unknown`, attempts + 1 | recovery planned as above; the queue behind it waits; the handle answers `infra/unknown-outcome` like every open path (#485) |
| a later part is refused after an earlier one committed (`acts.ts` `PartialRefusal`: a block without its pause) | `outcome-unknown`, attempts + 1 | recovery planned as above; the queue behind it waits; the handle answers `infra/unknown-outcome` (the invariant: no partial state without a planned completion; the pinned library refuses no pause or resume) |
| the act is refused for good (every other case, `unknown-contact` among them) | `done` with the refusal | none: a refusal is the library's answer to this state, a repeat would get the same; the queue moves on, the human sees the refusal |
| finish write fails | stays open | recovery planned; the act answers from the library's journal, no second act |
| gate closed (lock) | unchanged | the next opening completes the queue after its resume (`replayOpen`) |

## A contact joined meanwhile

After a second meeting the library keeps a fresh contact for a while and then joins it into the
contact known before (the chaining, Trust 6a.4; a merge, 2140): the known contact stays the entry,
the fresh id becomes one of its aliases. The library joins restrictively: the entry is blocked
where one of the two was (Message Tasks RLTP-MSG-6030), a class is `off` where one held `off`
(Trust 2160).

**Taken once the ids are one person.** `session.intent` reads every contact id of a command as its
entry (`entries.ts`) before the section, the dedupe key, the actId and the journal see it. A command
under an alias is the entry's command, in the entry's one queue; everything above holds unchanged.

**The person changed between taking and running.** A gesture is for the person as it stood when it
was taken: an ordered record journals the contacts joined into its entry by then (`aliases`). Its
attempt reads at the holder what its contact stands for. A contact was joined meanwhile where the
record's own contact is an alias of another entry now (taken for the fresh contact, run after the
join: held, a failure, a restart; or taken under the fresh id in the moment the holder had joined it
and the app had not read that yet), or where its entry holds an alias the record does not name (taken
for the known contact, the fresh one joined into it since). Then:

- a record that **lifts or grants** (`unblock`, `giveTrust`, `setPaused` off, `setClass` on or
  default) runs nothing more, no part of it: the person may carry a restriction the gesture never saw
  (a block or a pause of the other contact). Where every part committed before, it answers from the
  library's journal; otherwise it ends `done` with `refused/superseded`. A part left open stays undone
  (an unblock whose resume failed leaves the pause): lifting it takes a new gesture for the person;
- a record that **restricts** (`acts.ts` `restricts`: `block`, `withdrawTrust`, `setPaused` on,
  `setClass` off) runs. Taken for the fresh contact, it runs in the entry's section, behind everything
  open for the entry (the entry's open records get their attempt first; one that stays open holds it,
  its recovery planned), and as an act of its own on the entry (act id `<actId>@<entry>`, its parts
  under it): a part it committed for the fresh contact before the join was that contact's, the person
  gets the whole restriction. The record stays in the fresh contact's queue and is never rewritten.

So no gesture lifts a restriction of a person it did not see, and a restriction taken for either
contact holds for the person, whatever order the queues recover in and wherever a failure cut an act.
The price: a restriction of the fresh contact taken before the join ends behind a lift taken for the
person before that attempt ran, and a lift that did not run before the join has to be repeated by the
human. An entry joined, split off and joined again while one attempt runs is not followed from inside
its own section: the record stays open and its recovery starts over.

**One turn for reading and act** (`contact-turn.ts`). The write gate counts calls and does not order
them, and the holder's joining work (`receive`, `tick`, `resume`, `sharedConnectReceive`) runs on the
same clock as a recovery. The attempt reads what its contact stands for and acts on it alone in the
turn; joining work shares the turn among itself and never runs between the two. Without it a recovered
`unblock` of the fresh contact lifted the block of the person joined an instant later.

`giveTrust` reads the block of its contact inside the act (`acts.ts`), behind every gesture taken
before it: trust toward a blocked contact is refused (`contact-blocked`) when it runs, not when the
screen offered it.

**Keys.** A command knows where its dedupe key holds a contact (`acts.ts` `keyContact`; `send`,
`decide` and the codes name none). Only that part is read as its entry, at the acceptance, when a
running gesture or an open record is looked for (`keyNow`, `runningUnder`: found under any id of the
person), and when a journaled key is read. A draft key or a group id that equals a contact id stays
what it is.

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
trust acts in the queue (review 483 B1, rounds 1 to 3). `tests/rltp/re-meet-order.loopback.test.ts` holds a
contact joined meanwhile: the runs of the reviews of #563 (a part committed before the join, the
surviving id, a draft key that equals an alias among them), generated runs with the chaining before any
command and the first command left over (held before its journal, before its act, or cut and
recovered), each against the end state this section gives; `re-meet-commands.loopback.test.ts` the
commands under an alias; `contact-turn.test.ts` the turn.
