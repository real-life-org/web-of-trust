// Login into a web app (EXPERIMENTAL, library deviation D6, trust-protocol#211; prototype
// port-experimente `src/lab/anmeldung/`). A page reached by an app link (`…/a#…`) or by the verify
// page's scanner: it names the web app by its address, says that the feature is experimental and that
// the name the web app sees does not stay valid, offers to send the own name along, and answers the
// request when the person confirms. For a same-device request the web app's return address is opened
// in the browser. Nothing is stored: a lost answer is answered again by the person.

import type { LoginOutcome } from '../port'
import { loginTarget, readLoginRequest, type LoginTarget } from '../lib/login-request'
import { isResult, stay, type CancelPolicy, type Effect, type Machine, type ResultEvent, type Row, type Step } from './machine'

/** why the page cannot log in: the request cannot be answered safely, the web app refused, it could
 *  not be reached, or this app version cannot do it */
export type LoginFailure = 'login-invalid' | 'login-refused' | 'login-unreachable' | 'not-supported' | 'failed'

/** what the person agreed to share with the web app, fixed at the confirmation (review #557: a retry
 *  sends exactly this, not what the profile holds by then); both null: nothing */
export interface SharedProfile {
  readonly name: string | null
  readonly picture: string | null
}

export type LoginState =
  | { readonly name: 'invalid'; readonly run: number }
  | { readonly name: 'review'; readonly run: number; readonly raw: string; readonly target: LoginTarget }
  | { readonly name: 'sending'; readonly run: number; readonly raw: string; readonly target: LoginTarget; readonly shared: SharedProfile }
  | { readonly name: 'failed'; readonly run: number; readonly raw: string; readonly target: LoginTarget; readonly shared: SharedProfile; readonly code: LoginFailure }
  /** `returned`: for a same-device request, whether the browser could be opened; `url`: the web app's
   *  return address, offered again as a link the person taps (a blocked tab, a browser left behind) */
  | { readonly name: 'returning'; readonly run: number; readonly target: LoginTarget; readonly url: string }
  | { readonly name: 'done'; readonly run: number; readonly target: LoginTarget; readonly returned: 'none' | 'opened' | 'failed'; readonly url?: string }
  | { readonly name: 'exit'; readonly run: number }

export type LoginEvent =
  /** `shared`: the name and picture the person agreed to share (both null: none) */
  | { readonly type: 'confirm'; readonly shared: SharedProfile }
  | { readonly type: 'retry' }
  | { readonly type: 'back' }
  | { readonly type: 'done' }
  /** same-device: open the web app's return address again, by the person's own tap */
  | { readonly type: 'reopen' }

export type LoginEffect =
  | ({ readonly id: 'login.answer'; readonly raw: string; readonly shared: SharedProfile } & Effect)
  | ({ readonly id: 'login.open'; readonly url: string } & Effect)

const row = (id: string, event: string, to: string, cancel: CancelPolicy, resume: string, extra: { guard?: string; effects?: readonly string[] } = {}): Row => ({
  id,
  from: id.split('.')[0] ?? '',
  event,
  to,
  cancel,
  resume,
  ...extra,
})

const NOTHING = 'nothing stored'
const ANSWERED = 'nothing stored; whether the web app took the answer, only the web app knows'

export const LOGIN_TABLE: readonly Row[] = [
  row('invalid.back', 'back', 'exit', 'free', NOTHING),
  row('review.confirm', 'confirm', 'sending', 'after-effect', ANSWERED, { effects: ['login.answer'] }),
  row('review.back', 'back', 'exit', 'free', NOTHING),
  row('sending.result.done', 'result login.answer', 'done{returned: none}', 'free', ANSWERED, { guard: 'the web app took the answer' }),
  row('sending.result.return', 'result login.answer', 'returning', 'free', ANSWERED, { guard: 'same-device: a return address on the web app’s origin', effects: ['login.open'] }),
  row('sending.result.failed', 'result login.answer', 'failed{code}', 'free', ANSWERED),
  row('failed.retry', 'retry', 'sending', 'after-effect', ANSWERED, { effects: ['login.answer'] }),
  row('failed.back', 'back', 'exit', 'free', NOTHING),
  row('returning.result', 'result login.open', 'done{returned: opened | failed, url}', 'free', ANSWERED),
  row('done.reopen', 'reopen', 'returning', 'free', ANSWERED, { guard: 'same-device: a return address', effects: ['login.open'] }),
  row('done.done', 'done | back', 'exit', 'free', ANSWERED),
]

export const LOGIN_STATES = ['invalid', 'review', 'sending', 'failed', 'returning', 'done', 'exit'] as const satisfies readonly LoginState['name'][]

type S = LoginState
type E = LoginEvent | ResultEvent
type Out = Step<S, LoginEffect>

const go = (state: S, row: string): Out => ({ state, effects: [], row })

/** The page's first state for a raw request: `review`, or `invalid` when it cannot be answered safely. */
export function loginStart(raw: string): S {
  const request = readLoginRequest(raw)
  const target = request ? loginTarget(request) : null
  return target ? { name: 'review', run: 0, raw, target } : { name: 'invalid', run: 0 }
}

const FAILURES: readonly string[] = ['login-invalid', 'login-refused', 'login-unreachable', 'not-supported']

export function loginMachine(): Machine<S, LoginEvent, LoginEffect> {
  const answer = (s: S, raw: string, target: LoginTarget, shared: SharedProfile, rowId: string): Out => {
    const run = s.run + 1
    return { state: { name: 'sending', run, raw, target, shared }, effects: [{ id: 'login.answer', run, raw, shared }], row: rowId }
  }
  const transition = (s: S, e: E): Out => {
    switch (s.name) {
      case 'invalid':
        if (e.type === 'back') return go({ name: 'exit', run: s.run }, 'invalid.back')
        return stay(s)
      case 'review':
        if (e.type === 'confirm') return answer(s, s.raw, s.target, e.shared, 'review.confirm')
        if (e.type === 'back') return go({ name: 'exit', run: s.run }, 'review.back')
        return stay(s)
      case 'sending':
        if (isResult(e, s.run, 'login.answer')) {
          const outcome = e.result.value as LoginOutcome | undefined
          if (e.result.ok && outcome?.kind === 'return') {
            const run = s.run + 1
            return { state: { name: 'returning', run, target: s.target, url: outcome.url }, effects: [{ id: 'login.open', run, url: outcome.url }], row: 'sending.result.return' }
          }
          if (e.result.ok) return go({ name: 'done', run: s.run, target: s.target, returned: 'none' }, 'sending.result.done')
          const code = (FAILURES.includes(e.result.code ?? '') ? e.result.code : 'failed') as LoginFailure
          return go({ name: 'failed', run: s.run, raw: s.raw, target: s.target, shared: s.shared, code }, 'sending.result.failed')
        }
        return stay(s)
      case 'failed':
        if (e.type === 'retry') return answer(s, s.raw, s.target, s.shared, 'failed.retry')
        if (e.type === 'back') return go({ name: 'exit', run: s.run }, 'failed.back')
        return stay(s)
      case 'returning':
        if (isResult(e, s.run, 'login.open')) return go({ name: 'done', run: s.run, target: s.target, returned: e.result.ok ? 'opened' : 'failed', url: s.url }, 'returning.result')
        return stay(s)
      case 'done':
        if (e.type === 'reopen' && s.url) {
          const run = s.run + 1
          return { state: { name: 'returning', run, target: s.target, url: s.url }, effects: [{ id: 'login.open', run, url: s.url }], row: 'done.reopen' }
        }
        if (e.type === 'done' || e.type === 'back') return go({ name: 'exit', run: s.run }, 'done.done')
        return stay(s)
      case 'exit':
        return stay(s)
    }
  }
  return { name: 'login', table: LOGIN_TABLE, transition, sensitive: () => false }
}
