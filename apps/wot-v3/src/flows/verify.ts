// Verify in person, architecture §4.2 "Verifizieren": both roles in one machine (design
// ready/scanner/confirm/waiting/fallback/success). Success comes only from `verification === 'mutual'`
// in a published bundle (the hook sends `bundle` events), never from a command result. The machine
// holds no actId: every act is an intent of the command service under the port.

import type { BackRead, BackShow, CardPreview, CardRef, Connection, ConnectionId, ContactId, DecisionId, EncounterOutcome, RefusalCode, Verification } from '../port'
import { isResult, stay, type CancelPolicy, type Effect, type Machine, type ResultEvent, type Row, type Step } from './machine'
import { isLoginRequest } from '../lib/login-request'

/** The own displayed card while it is valid. */
export interface ShownCard {
  readonly qr: string
  readonly expiresAt: number
  /** the card's instance (E9); null where it is shown without a carrier offer */
  readonly card: CardRef | null
}

/** An open encounter-confirm as the bundle event names it: the card it answers (E9) and the name. */
export interface IncomingRef {
  readonly id: DecisionId
  readonly contactId: ContactId
  readonly card: CardRef | null
  readonly name: string | null
}

/** An open proposal of a connection ceremony as the bundle event names it: the shown code it answers
 *  and the name it states (unverified). There is no contact before the ceremony is complete. */
export interface ProposalRef {
  readonly id: DecisionId
  readonly connection: ConnectionId
  readonly card: CardRef | null
  readonly name: string | null
}

/** where a connection ceremony stands, from the last published bundle */
export type ConnectionState = Pick<Connection, 'status' | 'contactId' | 'name' | 'camera' | 'accepted' | 'backShown' | 'relayed' | 'expiresAt' | 'decision'>

/** `connect-failed`: the other side ended the connection ceremony with an error (its code is in the diagnostics) */
export type ScanErrorCode = Extract<RefusalCode, 'card-invalid' | 'card-self' | 'already-scanned' | 'code-expired' | 'code-used' | 'no-card' | 'code-too-long'> | 'failed' | 'connect-failed'
  /** a back-code that came in otherwise than through the camera: it counts only read in person */
  | 'back-not-camera'
  /** the own back-code outlived the code it answers; the contact it opened stays */
  | 'back-expired'
  /** the other side ended the ceremony with an error after the back-code opened the contact here */
  | 'connect-failed-kept'

/** Where a card came in (#489, kept up to the issuance for #487): the app's own camera, a link the
 *  app was opened with (another camera, a messenger), or typed. */
export type CaptureOrigin = 'camera' | 'url' | 'manual'

/** After an optical capture of a card that was captured before (N9): where the bundle says we are.
 *  `counter`: incoming, no open request (declined or gone) and the counter-step still offered: the same
 *  question as at the first scan comes before it (review 477, finding 3). */
export type CaptureFollow = 'confirm' | 'counter' | 'counter-pending' | 'mutual' | 'met' | 'none'

/** The note on the code screen after a repeated capture: `already-captured` when the contact is not
 *  known (an open request may be in the conversation), `nothing-open` when nothing is open for it and
 *  the counter-step is not offered yet (the other credential has not arrived) */
export type ReadyHint = 'already-captured' | 'nothing-open'

interface Base {
  readonly run: number
  readonly card: ShownCard | null
  /** contacts mutual in the last published bundle: a state entered after that bundle still sees it
   *  (review 420 R1-6) */
  readonly mutual: readonly string[]
  /** ids joined into another contact, from the last published bundle: alias → the survivor (Trust
   *  6a.4). Kept with `mutual`, so a result that arrives after the bundle resolves its id too (review 509) */
  readonly aliases?: Readonly<Record<string, ContactId>>
  /** the connection ceremonies of the last published bundle, by id: a state entered after that bundle
   *  still sees a ceremony that ended meanwhile */
  readonly connections?: Readonly<Record<string, ConnectionState>>
  /** a carrier in reach, as the last bundle's connectivity says (network, mediator) */
  readonly inReach?: boolean
}

/** Where the scanner's wait stands: `unknown` (its ceremony is not in a bundle yet: no answer either way),
 *  `wait` (read by the camera: the back-code after BACK_AFTER_MS without an acceptance), `link` (not read by
 *  the camera: no back-code), `accepted` (the acceptance arrived, the rest of the ceremony is under way).
 *  `kept`: the person chose "keep waiting" on the back-code. `due`: the wait's deadline passed while the
 *  ceremony was `unknown` (its first state then takes the back-code at once: the time already waited counts) */
export type ScannerPhase = 'unknown' | 'wait' | 'link' | 'accepted'

export type VerifyState =
  | (Base & { readonly name: 'showing'; readonly error: boolean })
  | (Base & { readonly name: 'ready'; readonly hint: ReadyHint | null })
  | (Base & { readonly name: 'cameraChecking' })
  | (Base & { readonly name: 'cameraExplain' })
  | (Base & { readonly name: 'scanning' })
  | (Base & { readonly name: 'cameraDenied' })
  | (Base & { readonly name: 'cameraUnavailable' })
  | (Base & { readonly name: 'manualEntry'; readonly text: string })
  | (Base & { readonly name: 'previewing'; readonly raw: string; readonly origin: CaptureOrigin })
  | (Base & { readonly name: 'scanError'; readonly code: ScanErrorCode })
  /** the scanner's question before it issues its step; a displayed card only (a sent card asks once, later) */
  | (Base & { readonly name: 'confirm'; readonly raw: string; readonly preview: CardPreview; readonly origin: CaptureOrigin })
  | (Base & { readonly name: 'committing'; readonly preview: CardPreview; readonly origin: CaptureOrigin })
  | (Base & { readonly name: 'waiting'; readonly contactId: ContactId; readonly name2: string | null; readonly waitLong: boolean })
  | (Base & { readonly name: 'loadingFallback'; readonly contactId: ContactId; readonly name2: string | null })
  | (Base & { readonly name: 'fallback'; readonly contactId: ContactId; readonly name2: string | null; readonly sentQr: string })
  | (Base & { readonly name: 'capturing'; readonly preview: CardPreview; readonly origin: CaptureOrigin })
  /** `decision`: the open request it answers; null when none is open any more (declined, gone) and the
   *  counter-step is offered directly */
  | (Base & { readonly name: 'confirmationRequired'; readonly contactId: ContactId; readonly decision: DecisionId | null; readonly name2: string | null; readonly busy: boolean })
  /** the bundle that answers the shown card arrived (E9): the shower confirms on the same screen */
  | (Base & { readonly name: 'confirmIncoming'; readonly contactId: ContactId; readonly decision: DecisionId; readonly name2: string | null; readonly busy: boolean; readonly failed: boolean })
  /** a proposal answers the shown code (a connection ceremony): the shower accepts or declines; a
   *  decline tells the other side and spends the code */
  | (Base & { readonly name: 'connectIncoming'; readonly connection: ConnectionId; readonly decision: DecisionId; readonly name2: string | null; readonly busy: 'accept' | 'decline' | null; readonly failed: boolean })
  /** the ceremony runs: the scanner waits for the shower's answer, the shower for the last documents.
   *  What the scanner does next is decided by `scannerStep` from the ceremony's state in the last bundle */
  | (Base & { readonly name: 'connecting'; readonly connection: ConnectionId; readonly name2: string | null; readonly role: 'scanner' | 'shower'; readonly waitLong: boolean; readonly phase?: ScannerPhase; readonly kept?: boolean; readonly due?: boolean })
  /** the scanner, no carrier in reach: its back-code is being made (shared-connect without a carrier) */
  | (Base & { readonly name: 'backing'; readonly connection: ConnectionId; readonly name2: string | null })
  /** the scanner shows its back-code for the shower's camera; its contact exists from here on */
  | (Base & { readonly name: 'backCode'; readonly connection: ConnectionId; readonly name2: string | null; readonly qr: string; readonly validUntil: number })
  /** the shower's camera read a back-code: the proposal it carries is taken like one the carrier brought;
   *  only the read's own result names the confirmation it opens (never a bundle) */
  | (Base & { readonly name: 'readingBack'; readonly connection?: ConnectionId })
  /** the shower declined the scanner's proposal; `kept`: the back-code opened a contact here, it stays */
  | (Base & { readonly name: 'declined'; readonly name2: string | null; readonly kept: boolean })
  | (Base & { readonly name: 'counterPending'; readonly contactId: ContactId; readonly name2: string | null })
  /** `connection`: the ceremony a success came from while it is still open (a later failure of it is shown) */
  | (Base & { readonly name: 'success'; readonly contactId: ContactId; readonly name2: string | null; readonly isNew: boolean; readonly connection?: ConnectionId })
  /** `deferred`: a confirmation answered "not now"; it stays open in the list and the conversation and
   *  does not come back as a sheet in this session (E6) */
  | (Base & { readonly name: 'exit'; readonly to: 'back' | 'chat'; readonly contactId: ContactId | null; readonly recognized: boolean; readonly deferred: DecisionId | null })
  /** a login request of a web app was read (experimental, flows/login.ts): the login page takes it */
  | (Base & { readonly name: 'exit'; readonly to: 'login'; readonly raw: string; readonly contactId: null; readonly recognized: false; readonly deferred: null })

export type VerifyEvent =
  | { readonly type: 'scan' }
  | { readonly type: 'manual' }
  /** a card link the app was opened with (#489): the same step as a code the camera read, origin `url` */
  | { readonly type: 'link'; readonly raw: string }
  | { readonly type: 'text'; readonly text: string }
  | { readonly type: 'submit' }
  | { readonly type: 'continue' }
  | { readonly type: 'openSettings' }
  | { readonly type: 'yes' }
  | { readonly type: 'notThem' }
  | { readonly type: 'keepWaiting' }
  | { readonly type: 'showCode' }
  | { readonly type: 'accept' }
  /** the shower says no to a proposal: the other side is told */
  | { readonly type: 'decline' }
  | { readonly type: 'notNow' }
  | { readonly type: 'leave' }
  | { readonly type: 'done' }
  /** "Next person": a fresh card (a new N) in the same flow */
  | { readonly type: 'back' }
  | { readonly type: 'retry' }
  /** the hook's view of the published bundle: verification per contact, open encounter-confirm decisions */
  | {
      readonly type: 'bundle'
      readonly verifications: Readonly<Record<string, Verification>>
      /** ids that now resolve to another contact (a second encounter joined into the first, Trust
       *  6a.4; entries merged, 2140): alias → the surviving contact */
      readonly aliases?: Readonly<Record<string, ContactId>>
      readonly decisions: readonly IncomingRef[]
      /** open proposals of connection ceremonies, and where every ceremony stands */
      readonly proposals?: readonly ProposalRef[]
      readonly connections?: Readonly<Record<string, ConnectionState>>
      readonly inReach?: boolean
    }

export type VerifyEffect =
  | ({ readonly id: 'ver.show' } & Effect)
  | ({ readonly id: 'ver.expire'; readonly at: number } & Effect)
  | ({ readonly id: 'cam.check' | 'cam.scan' | 'cam.settings' } & Effect)
  | ({ readonly id: 'ver.preview'; readonly raw: string } & Effect)
  | ({ readonly id: 'ver.confirm'; readonly raw: string; readonly origin: CaptureOrigin } & Effect)
  | ({ readonly id: 'ver.capture'; readonly raw: string } & Effect)
  | ({ readonly id: 'ver.wait'; readonly ms: number } & Effect)
  | ({ readonly id: 'ver.sent'; readonly contactId: ContactId } & Effect)
  | ({ readonly id: 'ver.counter'; readonly contactId: ContactId } & Effect)
  /** an accept past the answered code's end is not issued: the act refuses it (`code-expired`) */
  | ({ readonly id: 'ver.decide'; readonly decision: DecisionId; readonly choice: 'accept' | 'decline' } & Effect)
  | ({ readonly id: 'ver.back'; readonly connection: ConnectionId } & Effect)
  | ({ readonly id: 'ver.readBack'; readonly raw: string } & Effect)

/** every state name of the machine (screen catalog coverage) */
export const VERIFY_STATES = [
  'showing', 'ready', 'cameraChecking', 'cameraExplain', 'scanning', 'cameraDenied', 'cameraUnavailable', 'manualEntry',
  'previewing', 'scanError', 'confirm', 'committing', 'waiting', 'loadingFallback', 'fallback', 'capturing',
  'confirmationRequired', 'confirmIncoming', 'connectIncoming', 'connecting', 'backing', 'backCode', 'readingBack', 'declined', 'counterPending', 'success', 'exit',
] as const satisfies readonly VerifyState['name'][]

/** the waiting note turns into "no answer yet" after 20 s of device time: the confirmation returns over
 *  the network (the scanner's bundle reaches the displayed card's instance, TRANSPORT.md), the optical
 *  step is a way out, open from the start, the note only names it once an answer could have come */
export const WAIT_LONG_MS = 20_000

/** the scanner of a shown code waits this long for the acceptance over the carrier before its back-code
 *  comes on screen (the ceremony simulator's ACK_WAIT): it cannot tell whether it or the other side is
 *  without a connection. It measures "no acceptance yet", not "not delivered": shared-connect gives no
 *  signal before the acceptance */
export const BACK_AFTER_MS = 12_000

const row = (id: string, event: string, to: string, cancel: CancelPolicy, resume: string, extra: { guard?: string; effects?: readonly string[] } = {}): Row => ({
  id,
  from: id.split('.')[0] ?? '',
  event,
  to,
  cancel,
  resume,
  ...extra,
})

export const VERIFY_TABLE: readonly Row[] = [
  row('showing.result.ok', 'result ver.show', 'ready{card}', 'free', 'intent discard: a lost show is dropped, a new card needs a new gesture', { effects: ['ver.expire'] }),
  row('showing.result.failed', 'result ver.show', 'showing{error}', 'free', '–'),
  row('showing.retry', 'retry', 'showing', 'free', '–', { effects: ['ver.show'] }),
  row('ready.expire', 'result ver.expire', 'showing', 'free', '–', { guard: 'card expired while the screen is open', effects: ['ver.show'] }),
  row('ready.bundle.answered', 'bundle', 'confirmIncoming{card: null}', 'free', 'the decision stays open in the list and the conversation', { guard: 'an open encounter-confirm answers the shown card (E9): one card, one person' }),
  row('ready.scan', 'scan', 'cameraChecking', 'free', '–', { effects: ['cam.check'] }),
  row('ready.manual', 'manual', 'manualEntry', 'free', '–'),
  row('ready.link', 'link', 'previewing{raw, origin: url}', 'free', '–', { effects: ['ver.preview'] }),
  row('ready.back', 'back', 'exit(back)', 'free', '–'),
  row('cameraChecking.result.granted', 'result cam.check', 'scanning', 'free', '–', { guard: 'available, granted', effects: ['cam.scan'] }),
  row('cameraChecking.result.prompt.explain', 'result cam.check', 'cameraExplain', 'free', '–', { guard: 'available, not asked yet, the platform explains first (Android: the system stops asking after two denials)' }),
  row('cameraChecking.result.prompt.direct', 'result cam.check', 'scanning', 'free', '–', { guard: 'available, not asked yet, the browser asks itself (web)', effects: ['cam.scan'] }),
  row('cameraChecking.result.denied', 'result cam.check', 'cameraDenied', 'free', '–', { guard: 'denied' }),
  row('cameraChecking.result.unavailable', 'result cam.check', 'cameraUnavailable', 'free', '–', { guard: 'no camera or unsupported' }),
  row('cameraExplain.continue', 'continue', 'scanning', 'free', '–', { effects: ['cam.scan'] }),
  row('cameraExplain.back', 'back', 'ready', 'free', '–'),
  row('scanning.result.ok', 'result cam.scan', 'previewing', 'free', '–', { guard: 'a code', effects: ['ver.preview'] }),
  row('scanning.result.login', 'result cam.scan', 'exit(login)', 'free', 'nothing stored', { guard: 'a login request of a web app (experimental)' }),
  row('scanning.result.cancelled', 'result cam.scan', 'ready', 'free', '–', { guard: 'cancelled' }),
  row('scanning.result.denied', 'result cam.scan', 'cameraDenied', 'free', '–', { guard: 'permission denied' }),
  row('scanning.result.error', 'result cam.scan', 'cameraUnavailable', 'free', '–', { guard: 'camera error' }),
  row('scanning.back', 'back', 'ready', 'free', '–'),
  row('cameraDenied.openSettings', 'openSettings', 'cameraDenied', 'free', '–', { effects: ['cam.settings'] }),
  row('cameraDenied.manual', 'manual', 'manualEntry', 'free', '–'),
  row('cameraDenied.back', 'back', 'ready', 'free', '–'),
  row('cameraUnavailable.manual', 'manual', 'manualEntry', 'free', '–'),
  row('cameraUnavailable.back', 'back', 'ready', 'free', '–'),
  row('manualEntry.text', 'text', 'manualEntry{text}', 'free', '–'),
  row('manualEntry.submit', 'submit', 'previewing', 'free', '–', { guard: 'text not empty', effects: ['ver.preview'] }),
  row('manualEntry.submit.login', 'submit', 'exit(login)', 'free', 'nothing stored', { guard: 'a login request of a web app (experimental)' }),
  row('manualEntry.back', 'back', 'ready', 'free', '–'),
  row('previewing.result.ok', 'result ver.preview', 'confirm{preview}', 'free', 'pure, nothing stored', { guard: 'a displayed card, not the own code' }),
  // a sent card is taken over without a question: the capture (RLTP-ENC-5710) issues nothing, the one
  // question comes before the counter-step (C4, RLTP-ENC-5080, 5750; Anton 29.10., A1)
  row('previewing.result.sent', 'result ver.preview', 'capturing', 'after-effect', 'intent confirm-again; the library returns captured or already-captured on a repeat', { guard: 'a sent card', effects: ['ver.capture'] }),
  row('previewing.result.self', 'result ver.preview', 'scanError{card-self}', 'free', '–', { guard: 'own code' }),
  row('previewing.result.refused', 'result ver.preview', 'scanError{code}', 'free', '–'),
  row('scanError.retry', 'retry', 'ready', 'free', '–'),
  row('scanError.back', 'back', 'ready', 'free', '–'),
  row('confirm.yes', 'yes', 'committing', 'after-effect', 'intent confirm-again: never re-run on its own (N3); needs-confirmation after a loss', { effects: ['ver.confirm'] }),
  row('confirm.notThem', 'notThem', 'ready', 'free', '–'),
  row('committing.result.waiting', 'result ver.confirm', 'waiting', 'free', 'contact outgoing', { guard: 'scanned or completes', effects: ['ver.wait'] }),
  row('committing.result.mutual', 'result ver.confirm', 'success', 'free', '–', { guard: 'scanned or completes, the last bundle already mutual' }),
  row('committing.result.recognized', 'result ver.confirm', 'exit(chat, recognized)', 'free', '–', { guard: 'recognized' }),
  row('committing.result.refused', 'result ver.confirm', 'scanError{code}', 'free', 'intent done with the refusal'),
  row('waiting.result.long', 'result ver.wait', 'waiting{waitLong}', 'free', '–'),
  row('waiting.keepWaiting', 'keepWaiting', 'waiting', 'free', '–', { effects: ['ver.wait'] }),
  row('waiting.showCode', 'showCode', 'loadingFallback', 'free', 'sent card from the encounter cache', { effects: ['ver.sent'] }),
  row('waiting.bundle.mutual', 'bundle', 'success', 'free', '–', { guard: 'verification === mutual' }),
  row('waiting.leave', 'leave', 'exit(chat)', 'free', 'contact outgoing; mutual arrives later by network'),
  row('loadingFallback.bundle.mutual', 'bundle', 'success', 'free', '–', { guard: 'verification === mutual' }),
  row('loadingFallback.result.ok', 'result ver.sent', 'fallback{sentQr}', 'free', '–'),
  row('loadingFallback.result.failed', 'result ver.sent', 'waiting', 'free', '–'),
  row('fallback.bundle.mutual', 'bundle', 'success', 'free', '–', { guard: 'verification === mutual' }),
  row('fallback.leave', 'leave', 'exit(chat)', 'free', 'contact outgoing'),
  row('capturing.result.captured', 'result ver.capture', 'confirmationRequired', 'free', 'the decision stays open under the conversation'),
  row('capturing.result.again.confirm', 'result ver.capture', 'confirmationRequired', 'free', 'open decision from prompts()', { guard: 'already captured, decision open' }),
  row('capturing.result.again.counter', 'result ver.capture', 'confirmationRequired{decision: null}', 'free', 'nothing open; the counter-step after the question', { guard: 'already captured, incoming, no open request, counter-step offered' }),
  row('capturing.result.again.pending', 'result ver.capture', 'counterPending', 'free', '–', { guard: 'already captured, own step issued' }),
  row('capturing.result.again.mutual', 'result ver.capture', 'success{isNew: false}', 'free', '–', { guard: 'already captured, mutual' }),
  row('capturing.result.again.met', 'result ver.capture', 'ready{hint: nothing-open}', 'free', '–', { guard: 'already captured, known contact, nothing open, no counter-step offered yet' }),
  row('capturing.result.again.none', 'result ver.capture', 'ready{hint}', 'free', '–', { guard: 'already captured, nothing open' }),
  row('capturing.result.refused', 'result ver.capture', 'scanError{code}', 'free', 'intent done with the refusal'),
  row('confirmationRequired.accept', 'accept', 'confirmationRequired{busy}', 'after-effect', 'intent replay', { effects: ['ver.counter'] }),
  row('confirmationRequired.bundle.mutual', 'bundle', 'success', 'free', '–', { guard: 'verification === mutual (also while the counter-step runs)' }),
  row('confirmationRequired.result.ok', 'result ver.counter', 'counterPending', 'free', 'intent replay'),
  row('confirmationRequired.result.failed', 'result ver.counter', 'confirmationRequired', 'free', 'the decision stays open'),
  row('confirmationRequired.notNow', 'notNow', 'exit(back, deferred)', 'free', 'the decision stays open in the list and the conversation (E4: no decline here)'),
  row('confirmationRequired.leave', 'leave', 'exit(chat)', 'free', 'the decision stays open in the conversation'),
  row('confirmIncoming.accept', 'accept', 'confirmIncoming{busy}', 'after-effect', 'intent replay', { effects: ['ver.counter'] }),
  row('confirmIncoming.bundle.mutual', 'bundle', 'success', 'free', '–', { guard: 'verification === mutual (also while the counter-step runs)' }),
  row('confirmIncoming.result.ok', 'result ver.counter', 'counterPending', 'free', 'intent replay', { guard: 'not mutual yet' }),
  row('confirmIncoming.result.failed', 'result ver.counter', 'confirmIncoming{failed}', 'free', 'the decision stays open'),
  row('confirmIncoming.notNow', 'notNow', 'exit(back, deferred)', 'free', 'the decision stays open in the list and the conversation'),
  row('confirmIncoming.bundle.gone', 'bundle', 'showing', 'free', '–', { guard: 'not busy, the decision is no longer open (decided on another device or in the conversation)', effects: ['ver.show'] }),
  row('ready.bundle.proposed', 'bundle', 'connectIncoming{card: null}', 'free', 'the decision stays open in the list', { guard: 'an open proposal answers the shown code: one code, one person' }),
  // the scanner of a shown code (the responder): every step below is decided by `scannerStep` against the
  // newest state of its ceremony in the last bundle (stores.connections), on the first scan and on a resumption
  row('previewing.result.answered.notCamera', 'result ver.preview', 'scanError{code-used}', 'free', '–', { guard: 'a link this device answered, typed in or opened as a link: spent' }),
  row('scanner.end.complete', 'scannerStep', 'success', 'free', '–', { guard: 'the ceremony is complete with a contact' }),
  row('scanner.end.foreign', 'scannerStep', 'exit(back)', 'free', '–', { guard: 'complete without a contact (a counterpart whose app gives no channel)' }),
  row('scanner.end.declined', 'scannerStep', 'declined{kept}', 'free', '–', { guard: 'the other side declined; `kept`: the back-code opened a contact here' }),
  row('scanner.end.failed', 'scannerStep', 'scanError{connect-failed | connect-failed-kept}', 'free', '–', { guard: 'the other side ended the ceremony with an error' }),
  row('scanner.accepted', 'scannerStep', 'connecting{scanner} without a wait', 'free', 'the acceptance arrived over the carrier: no back-code any more', { guard: 'accepted, open, no contact yet' }),
  row('scanner.accepted.contact', 'scannerStep', 'success', 'free', '–', { guard: 'accepted, open, the contact stands (the back-code opened it)' }),
  row('scanner.back', 'scannerStep', 'backing', 'free', '–', { guard: 'open, not accepted, read by the camera; and the back-code shown before, a link without a relay, no carrier in reach (entry) or the wait over (due)', effects: ['ver.back'] }),
  row('scanner.wait', 'scannerStep', 'connecting{scanner}', 'free', '–', { guard: 'open, not accepted, read by the camera, a carrier in reach, a relay in the link', effects: ['ver.wait BACK_AFTER_MS'] }),
  row('scanner.unknown', 'scannerStep', 'connecting{scanner, unknown}', 'free', 'no answer either way', { guard: 'the ceremony is in no bundle yet' }),
  row('connecting.bundle.known', 'bundle', 'scannerStep(entry); a wait goes on with the deadline set at the scan', 'free', '–', { guard: 'the ceremony waited for appears in a bundle' }),
  row('connecting.unknown.due', 'result ver.wait', 'connecting{unknown, due}', 'free', '–', { guard: 'the deadline passed before any bundle named the ceremony' }),
  row('backing.leave', 'leave', 'exit(chat | back)', 'free', 'the ceremony goes on in the core', { guard: 'always: the way out while the code is made' }),
  row('readingBack.back', 'back', 'ready', 'free', 'the confirmation stays in the list once it is there'),
  row('connecting.carrier.lost', 'bundle', 'backing', 'free', '–', { guard: 'waiting for the acceptance by the camera, no carrier in reach any more, "keep waiting" not chosen', effects: ['ver.back'] }),
  row('success.bundle.failed', 'bundle', 'scanError{connect-failed | connect-failed-kept}', 'free', 'the contact stays', { guard: 'the open ceremony of an early success failed' }),
  row('readingBack.result.unknown', 'result ver.readBack', 'readingBack{connection}', 'free', 'no answer either way', { guard: 'taken or read again, the ceremony in no bundle yet' }),
  row('backing.result.notShown', 'result ver.back', 'scannerStep(bundle)', 'free', 'the act ran nothing', { guard: 'closed or accepted: the bundle that says so ends the code' }),
  row('scanner.wait.link', 'scannerStep', 'connecting{scanner}', 'free', '–', { guard: 'open, not accepted, not read by the camera: no back-code', effects: ['ver.wait WAIT_LONG_MS'] }),
  row('backCode.keepWaiting', 'keepWaiting', 'connecting{scanner}', 'free', 'the contact stays; the acceptance over the carrier ends the wait', { guard: 'the link names a relay', effects: ['ver.wait BACK_AFTER_MS'] }),
  row('backing.result.ok', 'result ver.back', 'backCode{qr, expiresAt}', 'free', 'intent replay: the same code again; the contact opened once', { guard: 'the ceremony neither ended nor accepted in the last bundle', effects: ['ver.expire'] }),
  row('backing.result.failed', 'result ver.back', 'scanError{no-card | code-too-long | code-expired | back-expired | failed}', 'free', 'the proposal stays in the core and goes out with a carrier'),
  row('backCode.expire', 'result ver.expire', 'scanError{back-expired | code-expired}', 'free', 'the contact stays when there is one', { guard: 'the code it answers ended; "the contact stays" only with this ceremony\'s contact' }),
  row('backCode.leave', 'leave', 'exit(chat)', 'free', 'the contact exists; the rest goes out with a carrier', { guard: 'the contact is in the last bundle, else exit(back)' }),
  row('previewing.result.back', 'result ver.preview', 'readingBack', 'free', 'not a human act; the confirmation is the decision', { guard: 'a back-code that answers an own shown code, read by the camera', effects: ['ver.readBack'] }),
  row('previewing.result.back.notCamera', 'result ver.preview', 'scanError{back-not-camera}', 'free', '–', { guard: 'a back-code typed in or opened as a link' }),
  row('readingBack.result.proposed', 'result ver.readBack', 'connectIncoming{card: null}', 'free', 'the decision stays open in the list', { guard: 'taken or read again, its ceremony\'s confirmation open in the last bundle' }),
  row('readingBack.result.contact', 'result ver.readBack', 'success', 'free', '–', { guard: 'taken or read again, the ceremony holds the contact' }),
  row('readingBack.result.ok', 'result ver.readBack', 'ready', 'free', '–', { guard: 'taken or read again, nothing open to ask (decided or ended meanwhile)' }),
  row('readingBack.result.failed', 'result ver.readBack', 'scanError{connect-failed-kept}', 'free', 'the contact stays', { guard: 'the ceremony ended with an error after the acceptance opened the contact' }),
  row('readingBack.result.refused', 'result ver.readBack', 'scanError{card-invalid | code-expired}', 'free', '–', { guard: 'refused, expired, no match' }),
  row('connectIncoming.accept', 'accept', 'connectIncoming{busy}', 'after-effect', 'intent replay', { effects: ['ver.decide'] }),
  row('connectIncoming.decline', 'decline', 'connectIncoming{busy}', 'after-effect', 'intent replay', { effects: ['ver.decide'] }),
  row('connectIncoming.result.accepted', 'result ver.decide', 'connecting{shower}', 'free', 'the ceremony completes from the core’s snapshot', { guard: 'accepted, not complete yet' }),
  row('connectIncoming.result.declined', 'result ver.decide', 'showing', 'free', '–', { guard: 'declined: the code is spent', effects: ['ver.show'] }),
  row('connectIncoming.result.expired', 'result ver.decide', 'showing', 'free', 'the proposal stays unanswered in the core until it expires there', { guard: 'accepted past the code’s end: nothing is issued, a fresh code', effects: ['ver.show'] }),
  row('connectIncoming.result.failed', 'result ver.decide', 'connectIncoming{failed}', 'free', 'the decision stays open'),
  row('connectIncoming.notNow', 'notNow', 'exit(back, deferred)', 'free', 'the decision stays open in the list'),
  row('connectIncoming.bundle.gone', 'bundle', 'showing', 'free', '–', { guard: 'not busy, the proposal is no longer open, the ceremony neither complete nor holding a contact (that is the success, connecting.bundle.complete)', effects: ['ver.show'] }),
  row('connecting.bundle.complete', 'bundle', 'success', 'free', '–', { guard: 'the ceremony is complete with a contact, or open with the contact the back-code opened' }),
  row('connecting.bundle.foreign', 'bundle', 'exit(back)', 'free', '–', { guard: 'complete without a contact (a counterpart whose app gives no channel)' }),
  row('connecting.bundle.declined', 'bundle', 'declined', 'free', '–', { guard: 'the other side declined' }),
  row('connecting.bundle.failed', 'bundle', 'scanError{connect-failed}', 'free', '–', { guard: 'the other side ended the ceremony with an error' }),
  row('connecting.result.long', 'result ver.wait', 'connecting{waitLong}', 'free', '–', { guard: 'not a scanner by the camera' }),
  row('connecting.keepWaiting', 'keepWaiting', 'connecting', 'free', '–', { guard: 'the long-wait note is shown', effects: ['ver.wait'] }),
  row('connecting.leave', 'leave', 'exit(back)', 'free', 'the ceremony goes on in the core'),
  row('declined.done', 'done', 'ready', 'free', '–'),
  row('counterPending.bundle.mutual', 'bundle', 'success', 'free', '–', { guard: 'verification === mutual' }),
  row('counterPending.leave', 'leave', 'exit(chat)', 'free', 'contact outgoing until the bundle arrives'),
  row('success.done', 'done', 'exit(chat)', 'free', '–'),
]

type S = VerifyState
type E = VerifyEvent | ResultEvent
type Out = Step<S, VerifyEffect>

type DistOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never
type Next = DistOmit<S, keyof Base> & Partial<Base>

/** what every state carries into the next, except `run` (review 509, #511): one list, checked by the
 *  compiler, so a field added to Base is carried by every transition or the build fails */
const CARRIED = ['card', 'mutual', 'aliases', 'connections', 'inReach'] as const satisfies readonly Exclude<keyof Base, 'run'>[]
type Uncarried = Exclude<Exclude<keyof Base, 'run'>, (typeof CARRIED)[number]>
const _everyBaseFieldCarried: [Uncarried] extends [never] ? true : never = true
void _everyBaseFieldCarried
const carried = (s: S): Omit<Base, 'run'> => Object.fromEntries(CARRIED.filter((k) => s[k] !== undefined).map((k) => [k, s[k]])) as Omit<Base, 'run'>

const goto = (s: S, next: Next, row: string | null): Out => ({ state: { run: s.run, ...carried(s), ...next } as S, effects: [], row })

function emit(s: S, next: Next, row: string, make: (run: number) => readonly VerifyEffect[]): Out {
  const run = s.run + 1
  return { state: { ...carried(s), ...next, run } as S, effects: make(run), row }
}

const show = (s: S, row: string): Out => emit(s, { name: 'showing', error: false, card: null }, row, (r) => [{ id: 'ver.show', run: r }])
const exit = (s: S, to: 'back' | 'chat', contactId: ContactId | null, row: string, deferred: DecisionId | null = null, recognized = false): Out =>
  goto(s, { name: 'exit', to, contactId, recognized, deferred }, row)
const toLogin = (s: S, raw: string, row: string): Out => goto(s, { name: 'exit', to: 'login', raw, contactId: null, recognized: false, deferred: null }, row)
/** back to ready: the card is shown again if it is still valid (the expiry timer restarts) */
const toReady = (s: S, row: string, hint: ReadyHint | null = null): Out =>
  s.card ? emit(s, { name: 'ready', hint }, row, (r) => [{ id: 'ver.expire', run: r, at: s.card?.expiresAt ?? 0 }]) : show(s, row)

const SCAN_ERRORS: readonly string[] = ['card-invalid', 'card-self', 'already-scanned', 'code-expired', 'code-used']
const scanCode = (code: string | undefined): ScanErrorCode => (code && SCAN_ERRORS.includes(code) ? (code as ScanErrorCode) : 'failed')

/** the contact an id stands for now, as the machine knows it from the last bundle: itself, or the
 *  survivor it was joined into */
const current = (s: S, contactId: ContactId): ContactId => s.aliases?.[contactId] ?? contactId
/** mutual by the last bundle, through an alias too: a state entered after that bundle sees it as well */
const isMutual = (s: S, contactId: ContactId): boolean => s.mutual.includes(current(s, contactId))
/** a bundle that says the contact is mutual now */
const mutual = (s: S, e: E, contactId: ContactId): boolean => e.type === 'bundle' && isMutual(s, contactId)
/** the success: the contact as it stands now; joined into an earlier one, it is a re-encounter (no
 *  confetti) */
const succeed = (s: S, contactId: ContactId, name2: string | null) => {
  const now = current(s, contactId)
  return { name: 'success' as const, contactId: now, name2, isNew: now === contactId }
}

export function verifyStart(): Out {
  return { state: { name: 'showing', run: 1, card: null, mutual: [], error: false }, effects: [{ id: 'ver.show', run: 1 }], row: null }
}

export function verifyTransition(s0: S, e: E): Out {
  if (e.type !== 'bundle') return step(s0, e)
  // every bundle refreshes the machine's view of who is mutual, whatever the state
  const now = Object.keys(e.verifications).filter((id) => e.verifications[id] === 'mutual').sort()
  const aliases = e.aliases ?? {}
  const connections = e.connections ?? {}
  const inReach = e.inReach ?? s0.inReach
  const same = now.join() === s0.mutual.join() && JSON.stringify(aliases) === JSON.stringify(s0.aliases ?? {}) && JSON.stringify(connections) === JSON.stringify(s0.connections ?? {}) && inReach === s0.inReach
  const s = same ? s0 : ({ ...s0, mutual: now, aliases, connections, ...(inReach === undefined ? {} : { inReach }) } as S)
  const out = step(s, e)
  return out.row === null && out.state === s && s !== s0 ? { state: s, effects: [], row: null } : out
}

function step(s: S, e: E): Out {
  switch (s.name) {
    case 'showing':
      if (isResult(e, s.run, 'ver.show')) {
        if (!e.result.ok) return goto(s, { name: 'showing', error: true }, 'showing.result.failed')
        const card = e.result.value as ShownCard
        return emit(s, { name: 'ready', hint: null, card }, 'showing.result.ok', (r) => [{ id: 'ver.expire', run: r, at: card.expiresAt }])
      }
      if (e.type === 'retry' && s.error) return show(s, 'showing.retry')
      if (e.type === 'back') return exit(s, 'back', null, 'ready.back')
      return stay(s)
    case 'ready':
      if (isResult(e, s.run, 'ver.expire')) return show(s, 'ready.expire')
      if (e.type === 'bundle') {
        // the bundle that answers this very card (E9, exact by its instance, never by timing): the card
        // is used (one card, one person, VTI Open Issue 8), the person in front of you is asked here
        const ref = s.card?.card ?? null
        const d = ref === null ? undefined : e.decisions.find((x) => x.card === ref)
        if (d) return goto(s, { name: 'confirmIncoming', card: null, contactId: d.contactId, decision: d.id, name2: d.name, busy: false, failed: false }, 'ready.bundle.answered')
        return proposedHere(s, e, 'ready.bundle.proposed') ?? stay(s)
      }
      if (e.type === 'scan') return emit(s, { name: 'cameraChecking' }, 'ready.scan', (r) => [{ id: 'cam.check', run: r }])
      if (e.type === 'manual') return goto(s, { name: 'manualEntry', text: '' }, 'ready.manual')
      if (e.type === 'link') return emit(s, { name: 'previewing', raw: e.raw, origin: 'url' }, 'ready.link', (r) => [{ id: 'ver.preview', run: r, raw: e.raw }])
      if (e.type === 'back') return exit(s, 'back', null, 'ready.back')
      return stay(s)
    case 'cameraChecking':
      if (isResult(e, s.run, 'cam.check')) {
        const v = e.result.value as { availability?: string; permission?: string; explain?: boolean } | undefined
        if (v?.availability !== 'available') return goto(s, { name: 'cameraUnavailable' }, 'cameraChecking.result.unavailable')
        if (v.permission === 'denied') return goto(s, { name: 'cameraDenied' }, 'cameraChecking.result.denied')
        if (v.permission === 'prompt' && v.explain === true) return goto(s, { name: 'cameraExplain' }, 'cameraChecking.result.prompt.explain')
        if (v.permission === 'prompt') return emit(s, { name: 'scanning' }, 'cameraChecking.result.prompt.direct', (r) => [{ id: 'cam.scan', run: r }])
        return emit(s, { name: 'scanning' }, 'cameraChecking.result.granted', (r) => [{ id: 'cam.scan', run: r }])
      }
      if (e.type === 'back') return toReady(s, 'scanning.back')
      return stay(s)
    case 'cameraExplain':
      if (e.type === 'continue') return emit(s, { name: 'scanning' }, 'cameraExplain.continue', (r) => [{ id: 'cam.scan', run: r }])
      if (e.type === 'back') return toReady(s, 'cameraExplain.back')
      return stay(s)
    case 'scanning':
      if (isResult(e, s.run, 'cam.scan')) {
        const v = e.result.value as { kind?: string; text?: string } | undefined
        if (v?.kind === 'ok' && v.text && isLoginRequest(v.text)) return toLogin(s, v.text, 'scanning.result.login')
        if (v?.kind === 'ok' && v.text) return emit(s, { name: 'previewing', raw: v.text, origin: 'camera' }, 'scanning.result.ok', (r) => [{ id: 'ver.preview', run: r, raw: v.text ?? '' }])
        if (v?.kind === 'cancelled') return toReady(s, 'scanning.result.cancelled')
        if (v?.kind === 'permission-denied') return goto(s, { name: 'cameraDenied' }, 'scanning.result.denied')
        return goto(s, { name: 'cameraUnavailable' }, 'scanning.result.error')
      }
      if (e.type === 'back') return toReady(s, 'scanning.back')
      return stay(s)
    case 'cameraDenied':
      if (e.type === 'openSettings') return emit(s, { name: 'cameraDenied' }, 'cameraDenied.openSettings', (r) => [{ id: 'cam.settings', run: r }])
      if (e.type === 'manual') return goto(s, { name: 'manualEntry', text: '' }, 'cameraDenied.manual')
      if (e.type === 'back') return toReady(s, 'cameraDenied.back')
      return stay(s)
    case 'cameraUnavailable':
      if (e.type === 'manual') return goto(s, { name: 'manualEntry', text: '' }, 'cameraUnavailable.manual')
      if (e.type === 'back') return toReady(s, 'cameraUnavailable.back')
      return stay(s)
    case 'manualEntry':
      if (e.type === 'text') return goto(s, { name: 'manualEntry', text: e.text }, 'manualEntry.text')
      if (e.type === 'submit' && s.text.trim() !== '') {
        const raw = s.text.trim()
        if (isLoginRequest(raw)) return toLogin(s, raw, 'manualEntry.submit.login')
        return emit(s, { name: 'previewing', raw, origin: 'manual' }, 'manualEntry.submit', (r) => [{ id: 'ver.preview', run: r, raw }])
      }
      if (e.type === 'back') return toReady(s, 'manualEntry.back')
      return stay(s)
    case 'previewing':
      if (isResult(e, s.run, 'ver.preview')) {
        if (!e.result.ok) return goto(s, { name: 'scanError', code: scanCode(e.result.code) }, 'previewing.result.refused')
        const preview = e.result.value as CardPreview
        if (preview.self) return goto(s, { name: 'scanError', code: 'card-self' }, 'previewing.result.self')
        if (preview.role === 'sent') return emit(s, { name: 'capturing', preview, origin: s.origin }, 'previewing.result.sent', (r) => [{ id: 'ver.capture', run: r, raw: s.raw }])
        if (preview.role === 'back') {
          // only read in person by this camera: a code typed in or opened as a link opens nothing
          if (s.origin !== 'camera') return goto(s, { name: 'scanError', code: 'back-not-camera' }, 'previewing.result.back.notCamera')
          return emit(s, { name: 'readingBack' }, 'previewing.result.back', (r) => [{ id: 'ver.readBack', run: r, raw: s.raw }])
        }
        // the very link this camera answered before (after a restart): resumed like the first scan, from the
        // stored ceremony as the last bundle has it
        if (preview.answered) {
          if (s.origin !== 'camera') return goto(s, { name: 'scanError', code: 'code-used' }, 'previewing.result.answered.notCamera')
          return scannerStep(s, preview.answered, 'entry')
        }
        return goto(s, { name: 'confirm', raw: s.raw, preview, origin: s.origin }, 'previewing.result.ok')
      }
      if (e.type === 'back') return toReady(s, 'scanning.back')
      return stay(s)
    case 'scanError':
      if (e.type === 'retry') return toReady(s, 'scanError.retry')
      if (e.type === 'back') return toReady(s, 'scanError.back')
      return stay(s)
    case 'confirm':
      if (e.type === 'yes') return emit(s, { name: 'committing', preview: s.preview, origin: s.origin }, 'confirm.yes', (r) => [{ id: 'ver.confirm', run: r, raw: s.raw, origin: s.origin }])
      if (e.type === 'notThem' || e.type === 'back') return toReady(s, 'confirm.notThem')
      return stay(s)
    case 'committing':
      if (isResult(e, s.run, 'ver.confirm')) {
        if (!e.result.ok) return goto(s, { name: 'scanError', code: scanCode(e.result.code) }, 'committing.result.refused')
        const o = e.result.value as EncounterOutcome
        if (o.kind === 'recognized') return exit(s, 'chat', o.contactId, 'committing.result.recognized', null, true)
        if (o.kind === 'proposed') {
          return scannerStep(s, o.connection, 'entry')
        }
        const contactId = (o as { contactId: ContactId }).contactId
        if (isMutual(s, contactId)) return goto(s, succeed(s, contactId, s.preview.name), 'committing.result.mutual')
        return emit(s, { name: 'waiting', contactId, name2: s.preview.name, waitLong: false }, 'committing.result.waiting', (r) => [{ id: 'ver.wait', run: r, ms: WAIT_LONG_MS }])
      }
      return stay(s)
    case 'waiting':
      if (mutual(s, e, s.contactId)) return goto(s, succeed(s, s.contactId, s.name2), 'waiting.bundle.mutual')
      if (isResult(e, s.run, 'ver.wait')) return goto(s, { name: 'waiting', contactId: s.contactId, name2: s.name2, waitLong: true }, 'waiting.result.long')
      if (e.type === 'keepWaiting') return emit(s, { name: 'waiting', contactId: s.contactId, name2: s.name2, waitLong: false }, 'waiting.keepWaiting', (r) => [{ id: 'ver.wait', run: r, ms: WAIT_LONG_MS }])
      if (e.type === 'showCode') return emit(s, { name: 'loadingFallback', contactId: s.contactId, name2: s.name2 }, 'waiting.showCode', (r) => [{ id: 'ver.sent', run: r, contactId: s.contactId }])
      if (e.type === 'leave' || e.type === 'back') return exit(s, 'chat', s.contactId, 'waiting.leave')
      return stay(s)
    case 'loadingFallback':
      if (mutual(s, e, s.contactId)) return goto(s, succeed(s, s.contactId, s.name2), 'loadingFallback.bundle.mutual')
      if (isResult(e, s.run, 'ver.sent')) {
        if (!e.result.ok) return goto(s, { name: 'waiting', contactId: s.contactId, name2: s.name2, waitLong: true }, 'loadingFallback.result.failed')
        return goto(s, { name: 'fallback', contactId: s.contactId, name2: s.name2, sentQr: (e.result.value as { qr: string }).qr }, 'loadingFallback.result.ok')
      }
      return stay(s)
    case 'fallback':
      if (mutual(s, e, s.contactId)) return goto(s, succeed(s, s.contactId, s.name2), 'fallback.bundle.mutual')
      if (e.type === 'leave' || e.type === 'back') return exit(s, 'chat', s.contactId, 'fallback.leave')
      return stay(s)
    case 'capturing':
      if (isResult(e, s.run, 'ver.capture')) {
        if (!e.result.ok) return goto(s, { name: 'scanError', code: scanCode(e.result.code) }, 'capturing.result.refused')
        const v = e.result.value as { outcome: EncounterOutcome; follow: CaptureFollow; decision: DecisionId | null; contactId: ContactId | null }
        const name2 = s.preview.name
        if (v.outcome.kind === 'captured') {
          return goto(s, { name: 'confirmationRequired', contactId: v.outcome.contactId, decision: v.outcome.decision, name2, busy: false }, 'capturing.result.captured')
        }
        if (v.follow === 'confirm' && v.contactId && v.decision) {
          return goto(s, { name: 'confirmationRequired', contactId: v.contactId, decision: v.decision, name2, busy: false }, 'capturing.result.again.confirm')
        }
        if (v.follow === 'counter' && v.contactId) {
          return goto(s, { name: 'confirmationRequired', contactId: v.contactId, decision: null, name2, busy: false }, 'capturing.result.again.counter')
        }
        if (v.follow === 'counter-pending' && v.contactId) return goto(s, { name: 'counterPending', contactId: v.contactId, name2 }, 'capturing.result.again.pending')
        if (v.follow === 'mutual' && v.contactId) return goto(s, { name: 'success', contactId: v.contactId, name2, isNew: false }, 'capturing.result.again.mutual')
        if (v.follow === 'met') return toReady(s, 'capturing.result.again.met', 'nothing-open')
        return toReady(s, 'capturing.result.again.none', 'already-captured')
      }
      return stay(s)
    case 'confirmationRequired':
      if (mutual(s, e, s.contactId)) return goto(s, succeed(s, s.contactId, s.name2), 'confirmationRequired.bundle.mutual')
      if (e.type === 'accept' && !s.busy) return emit(s, { ...pick(s), busy: true }, 'confirmationRequired.accept', (r) => [{ id: 'ver.counter', run: r, contactId: s.contactId }])
      if (isResult(e, s.run, 'ver.counter')) {
        if (!e.result.ok) return goto(s, { ...pick(s), busy: false }, 'confirmationRequired.result.failed')
        if (isMutual(s, s.contactId)) return goto(s, succeed(s, s.contactId, s.name2), 'confirmationRequired.bundle.mutual')
        return goto(s, { name: 'counterPending', contactId: s.contactId, name2: s.name2 }, 'confirmationRequired.result.ok')
      }
      if (e.type === 'notNow' && !s.busy) return exit(s, 'back', null, 'confirmationRequired.notNow', s.decision)
      if ((e.type === 'leave' || e.type === 'back') && !s.busy) return exit(s, 'chat', s.contactId, 'confirmationRequired.leave', s.decision)
      return stay(s)
    case 'confirmIncoming':
      if (mutual(s, e, s.contactId)) return goto(s, succeed(s, s.contactId, s.name2), 'confirmIncoming.bundle.mutual')
      if (e.type === 'accept' && !s.busy) return emit(s, { ...pickIncoming(s), busy: true, failed: false }, 'confirmIncoming.accept', (r) => [{ id: 'ver.counter', run: r, contactId: s.contactId }])
      if (isResult(e, s.run, 'ver.counter')) {
        if (!e.result.ok) return goto(s, { ...pickIncoming(s), busy: false, failed: true }, 'confirmIncoming.result.failed')
        if (isMutual(s, s.contactId)) return goto(s, succeed(s, s.contactId, s.name2), 'confirmIncoming.bundle.mutual')
        return goto(s, { name: 'counterPending', contactId: s.contactId, name2: s.name2 }, 'confirmIncoming.result.ok')
      }
      if ((e.type === 'notNow' || e.type === 'back' || e.type === 'leave') && !s.busy) return exit(s, 'back', null, 'confirmIncoming.notNow', s.decision)
      // decided elsewhere (another device, the conversation) and not mutual: the person is gone, a new card
      if (e.type === 'bundle' && !s.busy && !e.decisions.some((d) => d.id === s.decision)) return show(s, 'confirmIncoming.bundle.gone')
      return stay(s)
    case 'connectIncoming': {
      if (isResult(e, s.run, 'ver.decide')) {
        if (!e.result.ok && e.result.code === 'code-expired') return show(s, 'connectIncoming.result.expired')
        if (!e.result.ok) return goto(s, { ...pickConnect(s), busy: null, failed: true }, 'connectIncoming.result.failed')
        if (s.busy === 'decline') return show(s, 'connectIncoming.result.declined')
        return connectionEnd(s, s.connection, s.name2) ?? goto(s, { name: 'connecting', connection: s.connection, name2: s.name2, role: 'shower', waitLong: false }, 'connectIncoming.result.accepted')
      }
      if (s.busy) return stay(s)
      if (e.type === 'accept' || e.type === 'decline') {
        const choice = e.type
        return emit(s, { ...pickConnect(s), busy: choice, failed: false }, `connectIncoming.${choice}`, (r) => [{ id: 'ver.decide', run: r, decision: s.decision, choice }])
      }
      if (e.type === 'notNow' || e.type === 'back' || e.type === 'leave') return exit(s, 'back', null, 'connectIncoming.notNow', s.decision)
      if (e.type === 'bundle' && !(e.proposals ?? []).some((x) => x.id === s.decision)) {
        // decided elsewhere: a contact of this ceremony (accepted, open or complete) is the success; anything
        // else leaves a spent code behind
        const c = s.connections?.[s.connection]
        if (c && (c.status === 'complete' || (c.status === 'open' && c.contactId))) return connectionEnd(s, s.connection, s.name2) ?? stay(s)
        return show(s, 'connectIncoming.bundle.gone')
      }
      return stay(s)
    }
    case 'connecting': {
      const c = s.connections?.[s.connection]
      if (s.role === 'scanner') {
        if (e.type === 'bundle' && c) {
          // the ceremony ended or the acceptance arrived
          if (c.status !== 'open' || (c.accepted && s.phase !== 'accepted')) return scannerStep(s, s.connection, 'bundle')
          // the first state of the ceremony waited for: the step as on the first scan, with the deadline set at
          // the scan (passed: the code at once; running: the same timer goes on)
          if (s.phase === 'unknown') {
            if (s.due) return scannerStep(s, s.connection, 'due', 'connecting.bundle.known')
            const next = scannerStep(s, s.connection, 'entry', 'connecting.bundle.known')
            if (next.state.name === 'connecting' && next.state.phase === 'wait') return goto(s, { ...pickConnecting(s), waitLong: false, phase: 'wait' }, 'connecting.bundle.known')
            return next
          }
          // the carrier went away while it waits by the camera: the back-code now (unless the person chose to wait)
          if (s.phase === 'wait' && !s.kept && s.inReach === false) return emit(s, { name: 'backing', connection: s.connection, name2: s.name2 }, 'connecting.carrier.lost', (r) => [{ id: 'ver.back', run: r, connection: s.connection }])
          return stay(s)
        }
        // the wait for the acceptance is over: the encounter goes on by camera, unless the last bundle says otherwise
        if (isResult(e, s.run, 'ver.wait') && s.phase === 'wait') return scannerStep(s, s.connection, 'due')
        if (isResult(e, s.run, 'ver.wait') && s.phase === 'unknown') return goto(s, { ...pickConnecting(s), waitLong: false, due: true }, 'connecting.unknown.due')
        if (isResult(e, s.run, 'ver.wait') && s.phase !== 'link') return stay(s)
      } else {
        const ended = e.type === 'bundle' ? connectionEnd(s, s.connection, s.name2) : null
        if (ended) return ended
      }
      if (isResult(e, s.run, 'ver.wait')) return goto(s, { ...pickConnecting(s), waitLong: true }, 'connecting.result.long')
      if (e.type === 'keepWaiting' && s.waitLong) return emit(s, { ...pickConnecting(s), waitLong: false }, 'connecting.keepWaiting', (r) => [{ id: 'ver.wait', run: r, ms: WAIT_LONG_MS }])
      if (e.type === 'leave' || e.type === 'back') return exit(s, 'back', null, 'connecting.leave')
      return stay(s)
    }
    case 'backing': {
      // the last bundle first: a ceremony that ended or was accepted while the code was made shows that, never the code
      const c = s.connections?.[s.connection]
      if (e.type === 'bundle' && c && (c.status !== 'open' || c.accepted)) return scannerStep(s, s.connection, 'bundle')
      if (isResult(e, s.run, 'ver.back')) {
        if (c && (c.status !== 'open' || c.accepted)) return scannerStep(s, s.connection, 'bundle')
        // the app was in the background: nothing ran; back in front the code is due still, unless the newest
        // state says otherwise (no new wait)
        if (!e.result.ok && e.result.code === 'resumed') return scannerStep(s, s.connection, 'due')
        if (e.result.ok) {
          const v = e.result.value as BackShow
          if (v.kind === 'not-shown') {
            if (v.why === 'expired') return goto(s, { name: 'scanError', code: expiredCode(c) }, 'backing.result.failed')
            // closed or accepted: the act ran nothing; the bundle that says so decides (it waits for it)
            const next = scannerStep(s, s.connection, 'bundle')
            return next.state === s ? { ...next, row: 'backing.result.notShown' } : next
          }
          return emit(s, { name: 'backCode', connection: s.connection, name2: s.name2, qr: v.qr, validUntil: v.validUntil }, 'backing.result.ok', (r) => [{ id: 'ver.expire', run: r, at: v.validUntil }])
        }
        // without a back-code the proposal stays and goes out with a carrier; an ended code is one to scan
        // anew; anything else is a failure of this device, said as such
        const code = e.result.code
        const said: ScanErrorCode = code === 'no-card' || code === 'code-too-long' ? code : code === 'back-expired' ? expiredCode(c) : code === 'code-used' || code === 'code-expired' ? 'code-expired' : 'failed'
        return goto(s, { name: 'scanError', code: said }, 'backing.result.failed')
      }
      if (e.type === 'leave' || e.type === 'back') {
        const contactId = c?.contactId ?? null
        return exit(s, contactId ? 'chat' : 'back', contactId, 'backing.leave')
      }
      return stay(s)
    }
    case 'backCode': {
      // the code stays until the person leaves, the ceremony ends, or the acceptance arrives over the carrier
      const c = s.connections?.[s.connection]
      if (e.type === 'bundle' && c && (c.status !== 'open' || c.accepted)) return scannerStep(s, s.connection, 'bundle')
      if (isResult(e, s.run, 'ver.expire')) return goto(s, { name: 'scanError', code: expiredCode(c) }, 'backCode.expire')
      // back to waiting for the acceptance over the carrier, by the person's choice; the wait starts anew
      // (not for a link without a relay: no carrier brings an acceptance there, the code is the way)
      if (e.type === 'keepWaiting' && c?.relayed !== false) return emit(s, { name: 'connecting', connection: s.connection, name2: s.name2, role: 'scanner', waitLong: false, phase: 'wait', kept: true }, 'backCode.keepWaiting', (r) => [{ id: 'ver.wait', run: r, ms: BACK_AFTER_MS }])
      if (e.type === 'leave' || e.type === 'back' || e.type === 'done') {
        const contactId = c?.contactId ?? null
        return exit(s, contactId ? 'chat' : 'back', contactId, 'backCode.leave')
      }
      return stay(s)
    }
    case 'readingBack':
      if (isResult(e, s.run, 'ver.readBack')) {
        if (!e.result.ok) return goto(s, { name: 'scanError', code: scanCode(e.result.code) }, 'readingBack.result.refused')
        const v = e.result.value as BackRead
        if (v.kind === 'refused' || v.kind === 'expired' || v.kind === 'no-match') {
          const code: ScanErrorCode = v.kind === 'expired' || (v.kind === 'refused' && v.reason === 'expired-link') ? 'code-expired' : 'card-invalid'
          return goto(s, { name: 'scanError', code }, 'readingBack.result.refused')
        }
        return readBack(s, v.connection)
      }
      if (e.type === 'bundle' && s.connection && s.connections?.[s.connection]) return readBack(s, s.connection)
      if (e.type === 'back' || e.type === 'leave') return toReady(s, 'readingBack.back')
      return stay(s)
    case 'declined':
      if (e.type === 'done' || e.type === 'back' || e.type === 'retry') return toReady(s, 'declined.done')
      return stay(s)
    case 'counterPending':
      if (mutual(s, e, s.contactId)) return goto(s, succeed(s, s.contactId, s.name2), 'counterPending.bundle.mutual')
      if (e.type === 'leave' || e.type === 'back') return exit(s, 'chat', s.contactId, 'counterPending.leave')
      return stay(s)
    case 'success': {
      // an early success (the ceremony still open) shows a later failure of the same ceremony; the contact stays
      const c = s.connection ? s.connections?.[s.connection] : undefined
      if (e.type === 'bundle' && c?.status === 'failed') return goto(s, { name: 'scanError', code: c.contactId ? 'connect-failed-kept' : 'connect-failed' }, 'success.bundle.failed')
      if (e.type === 'done' || e.type === 'back') return exit(s, 'chat', s.contactId, 'success.done')
      return stay(s)
    }
    case 'exit':
      return stay(s)
  }
}

const pickConnect = (s: Extract<S, { name: 'connectIncoming' }>) => ({ name: s.name, connection: s.connection, decision: s.decision, name2: s.name2 })
const pickConnecting = (s: Extract<S, { name: 'connecting' }>) => ({ name: s.name, connection: s.connection, name2: s.name2, role: s.role, ...(s.phase ? { phase: s.phase } : {}), ...(s.kept ? { kept: s.kept } : {}), ...(s.due ? { due: s.due } : {}) })

/** the end of a back-code's link: "the contact stays" only when this ceremony's contact is there */
const expiredCode = (c: ConnectionState | undefined): ScanErrorCode => (c?.contactId ? 'back-expired' : 'code-expired')

/** the shower after reading a back-code: exactly this read's ceremony, as the newest bundle has it: its open
 *  confirmation, its contact, or nothing to ask (decided or ended meanwhile) */
function readBack(s: S, connection: ConnectionId): Out {
  const c = s.connections?.[connection]
  // an open ceremony with neither its confirmation, its acceptance nor a contact is a state from before the
  // read (an older bundle): no answer yet, the read ceremony is kept
  if (!c || (c.status === 'open' && !c.decision && !c.accepted && !c.contactId)) {
    return s.name === 'readingBack' && s.connection === connection ? stay(s) : goto(s, { name: 'readingBack', connection }, 'readingBack.result.unknown')
  }
  if (c?.status === 'open' && c.decision) return goto(s, { name: 'connectIncoming', card: null, connection, decision: c.decision, name2: c.name, busy: null, failed: false }, 'readingBack.result.proposed')
  if (c?.contactId && c.status !== 'declined' && c.status !== 'failed') return goto(s, { name: 'success', contactId: c.contactId, name2: c.name, isNew: true, ...(c.status === 'open' ? { connection } : {}) }, 'readingBack.result.contact')
  // ended with an error after the acceptance opened the contact here: said so, the contact stays
  if (c?.status === 'failed' && c.contactId) return goto(s, { name: 'scanError', code: 'connect-failed-kept' }, 'readingBack.result.failed')
  return toReady(s, 'readingBack.result.ok')
}

/** The scanner's step for its ceremony (the responder), decided against the newest state of exactly this
 *  ceremony in the last bundle and nothing else, the same on the first scan and on a resumption:
 *  - ended: complete (success, or out for a contact without a channel), declined, failed;
 *  - accepted over the carrier: the success when the contact stands, else the wait for the end, no back-code;
 *  - not read by this camera: wait, no back-code;
 *  - `entry` (the first scan, a resumption, back from the background): the back-code at once when it was
 *    shown before, the link names no relay, or no carrier is in reach; else wait BACK_AFTER_MS;
 *  - `due` (the wait is over): the back-code;
 *  - `bundle`: only the end and the acceptance (the caller asks for nothing else) */
function scannerStep(s: S, connection: ConnectionId, cause: 'entry' | 'due' | 'bundle', entryRow?: string): Out {
  const c = s.connections?.[connection]
  const name2 = c?.name ?? (s.name === 'connecting' || s.name === 'backing' || s.name === 'backCode' ? s.name2 : null)
  // `entryRow`: the ceremony waited for arrived; its own row stands for the step it takes
  const at = (r: string) => entryRow ?? r
  const open = c?.status === 'open' ? { connection } : {}
  if (c && c.status !== 'open') {
    if (c.status === 'complete') return c.contactId ? goto(s, { name: 'success', contactId: c.contactId, name2, isNew: true }, at('scanner.end.complete')) : exit(s, 'back', null, at('scanner.end.foreign'))
    if (c.status === 'declined') return goto(s, { name: 'declined', name2, kept: c.contactId !== null }, at('scanner.end.declined'))
    return goto(s, { name: 'scanError', code: c.contactId ? 'connect-failed-kept' : 'connect-failed' }, at('scanner.end.failed'))
  }
  if (c?.accepted) {
    if (c.contactId) return goto(s, { name: 'success', contactId: c.contactId, name2, isNew: true, ...open }, at('scanner.accepted.contact'))
    // a phase of its own, a new run: the wait's timer ends with it
    return emit(s, { name: 'connecting', connection, name2, role: 'scanner', waitLong: false, phase: 'accepted' }, at('scanner.accepted'), () => [])
  }
  if (cause === 'bundle') return stay(s)
  // no state of the ceremony yet: no answer either way, its id is kept until the first bundle names it
  // the deadline starts at the scan: it runs while the state is unknown and holds when it arrives
  if (!c) return emit(s, { name: 'connecting', connection, name2, role: 'scanner', waitLong: false, phase: 'unknown' }, at('scanner.unknown'), (r) => [{ id: 'ver.wait', run: r, ms: BACK_AFTER_MS }])
  if (!c.camera) return emit(s, { name: 'connecting', connection, name2, role: 'scanner', waitLong: false, phase: 'link' }, at('scanner.wait.link'), (r) => [{ id: 'ver.wait', run: r, ms: WAIT_LONG_MS }])
  if (cause === 'due' || c.backShown || c.relayed === false || s.inReach === false) return emit(s, { name: 'backing', connection, name2 }, at('scanner.back'), (r) => [{ id: 'ver.back', run: r, connection }])
  return emit(s, { name: 'connecting', connection, name2, role: 'scanner', waitLong: false, phase: 'wait' }, at('scanner.wait'), (r) => [{ id: 'ver.wait', run: r, ms: BACK_AFTER_MS }])
}

/** the proposal of a connection ceremony that answers the shown code (one code, one person) */
function proposedHere(s: S, e: Extract<E, { type: 'bundle' }>, row: string): Out | null {
  const ref = s.card?.card ?? null
  const p = ref === null ? undefined : e.proposals?.find((x) => x.card === ref)
  return p ? goto(s, { name: 'connectIncoming', card: null, connection: p.connection, decision: p.id, name2: p.name, busy: null, failed: false }, row) : null
}

/** Where a connection ceremony leaves the shower's flow, by the last bundle; null while it runs. Complete
 *  with a contact is the success; complete without one (a counterpart whose app gives no channel) leaves
 *  the flow; declined and failed say so. An open ceremony with a contact is the success too (the inviter's
 *  contact opens at its acceptance of a back-code; the rest follows with a carrier) */
function connectionEnd(s: S, connection: ConnectionId, name2: string | null): Out | null {
  const c = s.connections?.[connection]
  if (!c) return null
  if (c.status === 'open') return c.contactId ? goto(s, { name: 'success', contactId: c.contactId, name2, isNew: true, connection }, 'connecting.bundle.complete') : null
  if (c.status === 'complete') return c.contactId ? goto(s, { name: 'success', contactId: c.contactId, name2, isNew: true }, 'connecting.bundle.complete') : exit(s, 'back', null, 'connecting.bundle.foreign')
  if (c.status === 'declined') return goto(s, { name: 'declined', name2, kept: c.contactId !== null }, 'connecting.bundle.declined')
  return goto(s, { name: 'scanError', code: c.contactId ? 'connect-failed-kept' : 'connect-failed' }, 'connecting.bundle.failed')
}

const pick = (s: Extract<S, { name: 'confirmationRequired' }>) => ({ name: s.name, contactId: s.contactId, decision: s.decision, name2: s.name2 })
const pickIncoming = (s: Extract<S, { name: 'confirmIncoming' }>) => ({ name: s.name, contactId: s.contactId, decision: s.decision, name2: s.name2 })

export const verify: Machine<S, VerifyEvent, VerifyEffect> = {
  name: 'verify',
  table: VERIFY_TABLE,
  transition: verifyTransition,
  sensitive: () => false,
}
