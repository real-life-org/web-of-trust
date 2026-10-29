// Verify in person, architecture §4.2 "Verifizieren": both roles in one machine (design
// ready/scanner/confirm/waiting/fallback/success). Success comes only from `verification === 'mutual'`
// in a published bundle (the hook sends `bundle` events), never from a command result. The machine
// holds no actId: every act is an intent of the command service under the port.

import type { CardPreview, CardRef, ContactId, DecisionId, EncounterOutcome, RefusalCode, Verification } from '../port'
import { isResult, stay, type CancelPolicy, type Effect, type Machine, type ResultEvent, type Row, type Step } from './machine'

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

export type ScanErrorCode = Extract<RefusalCode, 'card-invalid' | 'card-self' | 'already-scanned' | 'code-expired' | 'code-used'> | 'failed'

/** After an optical capture of a card that was captured before (N9): where the bundle says we are. */
export type CaptureFollow = 'confirm' | 'counter-pending' | 'mutual' | 'none'

interface Base {
  readonly run: number
  readonly card: ShownCard | null
  /** contacts mutual in the last published bundle: a state entered after that bundle still sees it
   *  (review 420 R1-6) */
  readonly mutual: readonly string[]
  /** a person was verified in this flow and "next person" was chosen: the code screen shows the fresh
   *  card as the next person's (handshake UX artboard 3). Display only, no row depends on it. */
  readonly next?: true
}

export type VerifyState =
  | (Base & { readonly name: 'showing'; readonly error: boolean })
  | (Base & { readonly name: 'ready'; readonly hint: 'already-captured' | null })
  | (Base & { readonly name: 'cameraChecking' })
  | (Base & { readonly name: 'cameraExplain' })
  | (Base & { readonly name: 'scanning' })
  | (Base & { readonly name: 'cameraDenied' })
  | (Base & { readonly name: 'cameraUnavailable' })
  | (Base & { readonly name: 'manualEntry'; readonly text: string })
  | (Base & { readonly name: 'previewing'; readonly raw: string })
  | (Base & { readonly name: 'scanError'; readonly code: ScanErrorCode })
  /** the scanner's question before it issues its step; a displayed card only (a sent card asks once, later) */
  | (Base & { readonly name: 'confirm'; readonly raw: string; readonly preview: CardPreview })
  | (Base & { readonly name: 'committing'; readonly preview: CardPreview })
  | (Base & { readonly name: 'waiting'; readonly contactId: ContactId; readonly name2: string | null; readonly waitLong: boolean })
  | (Base & { readonly name: 'loadingFallback'; readonly contactId: ContactId; readonly name2: string | null })
  | (Base & { readonly name: 'fallback'; readonly contactId: ContactId; readonly name2: string | null; readonly sentQr: string })
  | (Base & { readonly name: 'capturing'; readonly preview: CardPreview })
  | (Base & { readonly name: 'confirmationRequired'; readonly contactId: ContactId; readonly decision: DecisionId; readonly name2: string | null; readonly busy: boolean })
  /** the bundle that answers the shown card arrived (E9): the shower confirms on the same screen */
  | (Base & { readonly name: 'confirmIncoming'; readonly contactId: ContactId; readonly decision: DecisionId; readonly name2: string | null; readonly busy: boolean; readonly failed: boolean })
  | (Base & { readonly name: 'counterPending'; readonly contactId: ContactId; readonly name2: string | null })
  | (Base & { readonly name: 'success'; readonly contactId: ContactId; readonly name2: string | null; readonly isNew: boolean })
  /** `deferred`: a confirmation answered "not now"; it stays open in the list and the conversation and
   *  does not come back as a sheet in this session (E6) */
  | (Base & { readonly name: 'exit'; readonly to: 'back' | 'chat'; readonly contactId: ContactId | null; readonly recognized: boolean; readonly deferred: DecisionId | null })

export type VerifyEvent =
  | { readonly type: 'scan' }
  | { readonly type: 'manual' }
  | { readonly type: 'text'; readonly text: string }
  | { readonly type: 'submit' }
  | { readonly type: 'continue' }
  | { readonly type: 'openSettings' }
  | { readonly type: 'yes' }
  | { readonly type: 'notThem' }
  | { readonly type: 'keepWaiting' }
  | { readonly type: 'showCode' }
  | { readonly type: 'accept' }
  | { readonly type: 'notNow' }
  | { readonly type: 'leave' }
  | { readonly type: 'done' }
  /** "Next person": a fresh card (a new N) in the same flow */
  | { readonly type: 'next' }
  | { readonly type: 'back' }
  | { readonly type: 'retry' }
  /** the hook's view of the published bundle: verification per contact, open encounter-confirm decisions */
  | { readonly type: 'bundle'; readonly verifications: Readonly<Record<string, Verification>>; readonly decisions: readonly IncomingRef[] }

export type VerifyEffect =
  | ({ readonly id: 'ver.show' } & Effect)
  | ({ readonly id: 'ver.expire'; readonly at: number } & Effect)
  | ({ readonly id: 'cam.check' | 'cam.scan' | 'cam.settings' } & Effect)
  | ({ readonly id: 'ver.preview'; readonly raw: string } & Effect)
  | ({ readonly id: 'ver.confirm' | 'ver.capture'; readonly raw: string } & Effect)
  | ({ readonly id: 'ver.wait'; readonly ms: number } & Effect)
  | ({ readonly id: 'ver.sent'; readonly contactId: ContactId } & Effect)
  | ({ readonly id: 'ver.counter'; readonly contactId: ContactId } & Effect)

/** every state name of the machine (screen catalog coverage) */
export const VERIFY_STATES = [
  'showing', 'ready', 'cameraChecking', 'cameraExplain', 'scanning', 'cameraDenied', 'cameraUnavailable', 'manualEntry',
  'previewing', 'scanError', 'confirm', 'committing', 'waiting', 'loadingFallback', 'fallback', 'capturing',
  'confirmationRequired', 'confirmIncoming', 'counterPending', 'success', 'exit',
] as const satisfies readonly VerifyState['name'][]

/** the waiting note turns into "no answer yet" after 20 s of device time: the confirmation returns over
 *  the network (the scanner's bundle reaches the displayed card's instance, TRANSPORT.md), the optical
 *  step is a way out, open from the start, the note only names it once an answer could have come */
export const WAIT_LONG_MS = 20_000

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
  row('ready.back', 'back', 'exit(back)', 'free', '–'),
  row('cameraChecking.result.granted', 'result cam.check', 'scanning', 'free', '–', { guard: 'available, granted', effects: ['cam.scan'] }),
  row('cameraChecking.result.prompt.explain', 'result cam.check', 'cameraExplain', 'free', '–', { guard: 'available, not asked yet, the platform explains first (Android: the system stops asking after two denials)' }),
  row('cameraChecking.result.prompt.direct', 'result cam.check', 'scanning', 'free', '–', { guard: 'available, not asked yet, the browser asks itself (web)', effects: ['cam.scan'] }),
  row('cameraChecking.result.denied', 'result cam.check', 'cameraDenied', 'free', '–', { guard: 'denied' }),
  row('cameraChecking.result.unavailable', 'result cam.check', 'cameraUnavailable', 'free', '–', { guard: 'no camera or unsupported' }),
  row('cameraExplain.continue', 'continue', 'scanning', 'free', '–', { effects: ['cam.scan'] }),
  row('cameraExplain.back', 'back', 'ready', 'free', '–'),
  row('scanning.result.ok', 'result cam.scan', 'previewing', 'free', '–', { guard: 'a code', effects: ['ver.preview'] }),
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
  row('capturing.result.again.pending', 'result ver.capture', 'counterPending', 'free', '–', { guard: 'already captured, own step issued' }),
  row('capturing.result.again.mutual', 'result ver.capture', 'success{isNew: false}', 'free', '–', { guard: 'already captured, mutual' }),
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
  row('counterPending.bundle.mutual', 'bundle', 'success', 'free', '–', { guard: 'verification === mutual' }),
  row('counterPending.leave', 'leave', 'exit(chat)', 'free', 'contact outgoing until the bundle arrives'),
  row('success.done', 'done', 'exit(chat)', 'free', '–'),
  row('success.next', 'next', 'showing', 'free', '–', { effects: ['ver.show'] }),
]

type S = VerifyState
type E = VerifyEvent | ResultEvent
type Out = Step<S, VerifyEffect>

type DistOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never
type Next = DistOmit<S, keyof Base> & Partial<Base>

const carry = (s: S): { next?: true } => (s.next ? { next: true } : {})
const goto = (s: S, next: Next, row: string | null): Out => ({ state: { run: s.run, card: s.card, mutual: s.mutual, ...carry(s), ...next } as S, effects: [], row })

function emit(s: S, next: Next, row: string, make: (run: number) => readonly VerifyEffect[]): Out {
  const run = s.run + 1
  return { state: { card: s.card, mutual: s.mutual, ...carry(s), ...next, run } as S, effects: make(run), row }
}

const show = (s: S, row: string): Out => emit(s, { name: 'showing', error: false, card: null }, row, (r) => [{ id: 'ver.show', run: r }])
const exit = (s: S, to: 'back' | 'chat', contactId: ContactId | null, row: string, deferred: DecisionId | null = null, recognized = false): Out =>
  goto(s, { name: 'exit', to, contactId, recognized, deferred }, row)
/** back to ready: the card is shown again if it is still valid (the expiry timer restarts) */
const toReady = (s: S, row: string, hint: 'already-captured' | null = null): Out =>
  s.card ? emit(s, { name: 'ready', hint }, row, (r) => [{ id: 'ver.expire', run: r, at: s.card?.expiresAt ?? 0 }]) : show(s, row)

const SCAN_ERRORS: readonly string[] = ['card-invalid', 'card-self', 'already-scanned', 'code-expired', 'code-used']
const scanCode = (code: string | undefined): ScanErrorCode => (code && SCAN_ERRORS.includes(code) ? (code as ScanErrorCode) : 'failed')

const mutual = (e: E, contactId: ContactId): boolean => e.type === 'bundle' && e.verifications[contactId] === 'mutual'

export function verifyStart(): Out {
  return { state: { name: 'showing', run: 1, card: null, mutual: [], error: false }, effects: [{ id: 'ver.show', run: 1 }], row: null }
}

export function verifyTransition(s0: S, e: E): Out {
  if (e.type !== 'bundle') return step(s0, e)
  // every bundle refreshes the machine's view of who is mutual, whatever the state
  const now = Object.keys(e.verifications).filter((id) => e.verifications[id] === 'mutual').sort()
  const s = now.join() === s0.mutual.join() ? s0 : ({ ...s0, mutual: now } as S)
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
        return stay(s)
      }
      if (e.type === 'scan') return emit(s, { name: 'cameraChecking' }, 'ready.scan', (r) => [{ id: 'cam.check', run: r }])
      if (e.type === 'manual') return goto(s, { name: 'manualEntry', text: '' }, 'ready.manual')
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
        if (v?.kind === 'ok' && v.text) return emit(s, { name: 'previewing', raw: v.text }, 'scanning.result.ok', (r) => [{ id: 'ver.preview', run: r, raw: v.text ?? '' }])
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
        return emit(s, { name: 'previewing', raw }, 'manualEntry.submit', (r) => [{ id: 'ver.preview', run: r, raw }])
      }
      if (e.type === 'back') return toReady(s, 'manualEntry.back')
      return stay(s)
    case 'previewing':
      if (isResult(e, s.run, 'ver.preview')) {
        if (!e.result.ok) return goto(s, { name: 'scanError', code: scanCode(e.result.code) }, 'previewing.result.refused')
        const preview = e.result.value as CardPreview
        if (preview.self) return goto(s, { name: 'scanError', code: 'card-self' }, 'previewing.result.self')
        if (preview.role === 'sent') return emit(s, { name: 'capturing', preview }, 'previewing.result.sent', (r) => [{ id: 'ver.capture', run: r, raw: s.raw }])
        return goto(s, { name: 'confirm', raw: s.raw, preview }, 'previewing.result.ok')
      }
      if (e.type === 'back') return toReady(s, 'scanning.back')
      return stay(s)
    case 'scanError':
      if (e.type === 'retry') return toReady(s, 'scanError.retry')
      if (e.type === 'back') return toReady(s, 'scanError.back')
      return stay(s)
    case 'confirm':
      if (e.type === 'yes') return emit(s, { name: 'committing', preview: s.preview }, 'confirm.yes', (r) => [{ id: 'ver.confirm', run: r, raw: s.raw }])
      if (e.type === 'notThem' || e.type === 'back') return toReady(s, 'confirm.notThem')
      return stay(s)
    case 'committing':
      if (isResult(e, s.run, 'ver.confirm')) {
        if (!e.result.ok) return goto(s, { name: 'scanError', code: scanCode(e.result.code) }, 'committing.result.refused')
        const o = e.result.value as EncounterOutcome
        if (o.kind === 'recognized') return exit(s, 'chat', o.contactId, 'committing.result.recognized', null, true)
        const contactId = (o as { contactId: ContactId }).contactId
        if (s.mutual.includes(contactId)) return goto(s, { name: 'success', contactId, name2: s.preview.name, isNew: true }, 'committing.result.mutual')
        return emit(s, { name: 'waiting', contactId, name2: s.preview.name, waitLong: false }, 'committing.result.waiting', (r) => [{ id: 'ver.wait', run: r, ms: WAIT_LONG_MS }])
      }
      return stay(s)
    case 'waiting':
      if (mutual(e, s.contactId)) return goto(s, { name: 'success', contactId: s.contactId, name2: s.name2, isNew: true }, 'waiting.bundle.mutual')
      if (isResult(e, s.run, 'ver.wait')) return goto(s, { name: 'waiting', contactId: s.contactId, name2: s.name2, waitLong: true }, 'waiting.result.long')
      if (e.type === 'keepWaiting') return emit(s, { name: 'waiting', contactId: s.contactId, name2: s.name2, waitLong: false }, 'waiting.keepWaiting', (r) => [{ id: 'ver.wait', run: r, ms: WAIT_LONG_MS }])
      if (e.type === 'showCode') return emit(s, { name: 'loadingFallback', contactId: s.contactId, name2: s.name2 }, 'waiting.showCode', (r) => [{ id: 'ver.sent', run: r, contactId: s.contactId }])
      if (e.type === 'leave' || e.type === 'back') return exit(s, 'chat', s.contactId, 'waiting.leave')
      return stay(s)
    case 'loadingFallback':
      if (mutual(e, s.contactId)) return goto(s, { name: 'success', contactId: s.contactId, name2: s.name2, isNew: true }, 'loadingFallback.bundle.mutual')
      if (isResult(e, s.run, 'ver.sent')) {
        if (!e.result.ok) return goto(s, { name: 'waiting', contactId: s.contactId, name2: s.name2, waitLong: true }, 'loadingFallback.result.failed')
        return goto(s, { name: 'fallback', contactId: s.contactId, name2: s.name2, sentQr: (e.result.value as { qr: string }).qr }, 'loadingFallback.result.ok')
      }
      return stay(s)
    case 'fallback':
      if (mutual(e, s.contactId)) return goto(s, { name: 'success', contactId: s.contactId, name2: s.name2, isNew: true }, 'fallback.bundle.mutual')
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
        if (v.follow === 'counter-pending' && v.contactId) return goto(s, { name: 'counterPending', contactId: v.contactId, name2 }, 'capturing.result.again.pending')
        if (v.follow === 'mutual' && v.contactId) return goto(s, { name: 'success', contactId: v.contactId, name2, isNew: false }, 'capturing.result.again.mutual')
        return toReady(s, 'capturing.result.again.none', 'already-captured')
      }
      return stay(s)
    case 'confirmationRequired':
      if (mutual(e, s.contactId)) return goto(s, { name: 'success', contactId: s.contactId, name2: s.name2, isNew: true }, 'confirmationRequired.bundle.mutual')
      if (e.type === 'accept' && !s.busy) return emit(s, { ...pick(s), busy: true }, 'confirmationRequired.accept', (r) => [{ id: 'ver.counter', run: r, contactId: s.contactId }])
      if (isResult(e, s.run, 'ver.counter')) {
        if (!e.result.ok) return goto(s, { ...pick(s), busy: false }, 'confirmationRequired.result.failed')
        if (s.mutual.includes(s.contactId)) return goto(s, { name: 'success', contactId: s.contactId, name2: s.name2, isNew: true }, 'confirmationRequired.bundle.mutual')
        return goto(s, { name: 'counterPending', contactId: s.contactId, name2: s.name2 }, 'confirmationRequired.result.ok')
      }
      if (e.type === 'notNow' && !s.busy) return exit(s, 'back', null, 'confirmationRequired.notNow', s.decision)
      if ((e.type === 'leave' || e.type === 'back') && !s.busy) return exit(s, 'chat', s.contactId, 'confirmationRequired.leave', s.decision)
      return stay(s)
    case 'confirmIncoming':
      if (mutual(e, s.contactId)) return goto(s, { name: 'success', contactId: s.contactId, name2: s.name2, isNew: true }, 'confirmIncoming.bundle.mutual')
      if (e.type === 'accept' && !s.busy) return emit(s, { ...pickIncoming(s), busy: true, failed: false }, 'confirmIncoming.accept', (r) => [{ id: 'ver.counter', run: r, contactId: s.contactId }])
      if (isResult(e, s.run, 'ver.counter')) {
        if (!e.result.ok) return goto(s, { ...pickIncoming(s), busy: false, failed: true }, 'confirmIncoming.result.failed')
        if (s.mutual.includes(s.contactId)) return goto(s, { name: 'success', contactId: s.contactId, name2: s.name2, isNew: true }, 'confirmIncoming.bundle.mutual')
        return goto(s, { name: 'counterPending', contactId: s.contactId, name2: s.name2 }, 'confirmIncoming.result.ok')
      }
      if ((e.type === 'notNow' || e.type === 'back' || e.type === 'leave') && !s.busy) return exit(s, 'back', null, 'confirmIncoming.notNow', s.decision)
      // decided elsewhere (another device, the conversation) and not mutual: the person is gone, a new card
      if (e.type === 'bundle' && !s.busy && !e.decisions.some((d) => d.id === s.decision)) return show(s, 'confirmIncoming.bundle.gone')
      return stay(s)
    case 'counterPending':
      if (mutual(e, s.contactId)) return goto(s, { name: 'success', contactId: s.contactId, name2: s.name2, isNew: true }, 'counterPending.bundle.mutual')
      if (e.type === 'leave' || e.type === 'back') return exit(s, 'chat', s.contactId, 'counterPending.leave')
      return stay(s)
    case 'success':
      if (e.type === 'done' || e.type === 'back') return exit(s, 'chat', s.contactId, 'success.done')
      if (e.type === 'next') return show({ ...s, next: true }, 'success.next')
      return stay(s)
    case 'exit':
      return stay(s)
  }
}

const pick = (s: Extract<S, { name: 'confirmationRequired' }>) => ({ name: s.name, contactId: s.contactId, decision: s.decision, name2: s.name2 })
const pickIncoming = (s: Extract<S, { name: 'confirmIncoming' }>) => ({ name: s.name, contactId: s.contactId, decision: s.decision, name2: s.name2 })

export const verify: Machine<S, VerifyEvent, VerifyEffect> = {
  name: 'verify',
  table: VERIFY_TABLE,
  transition: verifyTransition,
  sensitive: () => false,
}
