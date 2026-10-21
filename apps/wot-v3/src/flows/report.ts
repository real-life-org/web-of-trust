// Report and block (paper "Nachricht als Trust Task" §6, Anton 19.10./20.10.): a notice page (what the
// app is, that a report only informs, what is sent), the messages to report (at most 20, with a
// preview of the mail), then confirming blocks the contact on this device (block plus pause, §7) and
// opens a mail draft to the publisher. A long transcript goes as a text file through the share sheet;
// without a mail app the address and the text are offered to copy. The block stays if the mail is
// abandoned. The machine holds no actId; the block is an intent of the command service.

import type { ContactId } from '../port'
import type { ReportMail } from '../lib/report'
import { isResult, stay, type CancelPolicy, type Effect, type Machine, type ResultEvent, type Row, type Step } from './machine'

export const MAX_SELECTED = 20

export type ReportState =
  | { readonly name: 'info'; readonly run: number; readonly selected: readonly string[] }
  | { readonly name: 'selecting'; readonly run: number; readonly selected: readonly string[] }
  | { readonly name: 'review'; readonly run: number; readonly selected: readonly string[] }
  | { readonly name: 'blocking'; readonly run: number; readonly selected: readonly string[]; readonly mail: ReportMail }
  | { readonly name: 'blockFailed'; readonly run: number; readonly selected: readonly string[]; readonly mail: ReportMail }
  | { readonly name: 'composing'; readonly run: number; readonly mail: ReportMail }
  | { readonly name: 'handedOver'; readonly run: number; readonly mail: ReportMail }
  | { readonly name: 'fallback'; readonly run: number; readonly mail: ReportMail; readonly copied: 'address' | 'text' | null; readonly copyFailed: boolean }
  | { readonly name: 'exit'; readonly run: number; readonly to: 'back' | 'chat' }

export type ReportEvent =
  | { readonly type: 'next' }
  | { readonly type: 'back' }
  | { readonly type: 'toggle'; readonly id: string }
  | { readonly type: 'confirm'; readonly mail: ReportMail }
  | { readonly type: 'retry' }
  | { readonly type: 'openMail' }
  | { readonly type: 'noMailApp' }
  | { readonly type: 'copy'; readonly what: 'address' | 'text' }
  | { readonly type: 'done' }

export type ReportEffect =
  | ({ readonly id: 'rep.block'; readonly contactId: ContactId } & Effect)
  | ({ readonly id: 'rep.compose'; readonly mail: ReportMail } & Effect)
  | ({ readonly id: 'rep.copy'; readonly what: 'address' | 'text'; readonly text: string } & Effect)

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

export const REPORT_TABLE: readonly Row[] = [
  row('info.next', 'next', 'selecting', 'free', NOTHING),
  row('info.back', 'back', 'exit(back)', 'free', NOTHING),
  row('selecting.toggle.off', 'toggle', 'selecting', 'free', NOTHING, { guard: 'selected' }),
  row('selecting.toggle.on', 'toggle', 'selecting', 'free', NOTHING, { guard: `not selected, fewer than ${MAX_SELECTED}` }),
  row('selecting.next', 'next', 'review', 'free', NOTHING, { guard: 'at least one message' }),
  row('selecting.back', 'back', 'info', 'free', NOTHING),
  row('review.confirm', 'confirm', 'blocking', 'after-effect', 'intent block (replay): the block is repeated after a loss, the mail is not', { effects: ['rep.block'] }),
  row('review.back', 'back', 'selecting', 'free', NOTHING),
  row('blocking.result.ok', 'result rep.block', 'composing', 'after-effect', 'contact blocked', { guard: 'blocked (or blocked already)', effects: ['rep.compose'] }),
  row('blocking.result.failed', 'result rep.block', 'blockFailed', 'free', 'intent block open or refused'),
  row('blockFailed.retry', 'retry', 'blocking', 'after-effect', 'intent block', { effects: ['rep.block'] }),
  row('blockFailed.back', 'back', 'exit(back)', 'free', 'nothing sent'),
  row('composing.result.opened', 'result rep.compose', 'handedOver', 'free', 'the draft is the mail app’s'),
  row('composing.result.unavailable', 'result rep.compose', 'fallback', 'free', '–', { guard: 'no mail app, or no file sharing for a long transcript' }),
  row('handedOver.openMail', 'openMail', 'composing', 'free', '–', { effects: ['rep.compose'] }),
  row('handedOver.noMailApp', 'noMailApp', 'fallback', 'free', '–'),
  row('handedOver.done', 'done', 'exit(chat)', 'free', 'contact blocked; whether the mail went out only the mail app knows'),
  row('fallback.copy', 'copy', 'fallback{copied}', 'free', '–', { effects: ['rep.copy'] }),
  row('fallback.result.copy', 'result rep.copy', 'fallback{copied | copyFailed}', 'free', '–'),
  row('fallback.openMail', 'openMail', 'composing', 'free', '–', { effects: ['rep.compose'] }),
  row('fallback.done', 'done', 'exit(chat)', 'free', 'contact blocked; not reported unless the text was sent'),
]

type S = ReportState
type E = ReportEvent | ResultEvent
type Out = Step<S, ReportEffect>

const go = (state: S, row: string): Out => ({ state, effects: [], row })

export const reportStates = ['info', 'selecting', 'review', 'blocking', 'blockFailed', 'composing', 'handedOver', 'fallback', 'exit'] as const satisfies readonly S['name'][]

/** `preselected`: the last messages of the conversation, at most MAX_SELECTED (the screen decides). */
export function reportStart(preselected: readonly string[]): S {
  return { name: 'info', run: 0, selected: preselected.slice(-MAX_SELECTED) }
}

export function reportMachine(contactId: ContactId): Machine<S, ReportEvent, ReportEffect> {
  const block = (s: S, selected: readonly string[], mail: ReportMail, rowId: string): Out => {
    const run = s.run + 1
    return { state: { name: 'blocking', run, selected, mail }, effects: [{ id: 'rep.block', run, contactId }], row: rowId }
  }
  const compose = (s: S, mail: ReportMail, rowId: string): Out => {
    const run = s.run + 1
    return { state: { name: 'composing', run, mail }, effects: [{ id: 'rep.compose', run, mail }], row: rowId }
  }
  const transition = (s: S, e: E): Out => {
    switch (s.name) {
      case 'info':
        if (e.type === 'next') return go({ name: 'selecting', run: s.run, selected: s.selected }, 'info.next')
        if (e.type === 'back') return go({ name: 'exit', run: s.run, to: 'back' }, 'info.back')
        return stay(s)
      case 'selecting':
        if (e.type === 'toggle') {
          if (s.selected.includes(e.id)) return go({ ...s, selected: s.selected.filter((x) => x !== e.id) }, 'selecting.toggle.off')
          if (s.selected.length < MAX_SELECTED) return go({ ...s, selected: [...s.selected, e.id] }, 'selecting.toggle.on')
          return stay(s)
        }
        if (e.type === 'next' && s.selected.length > 0) return go({ name: 'review', run: s.run, selected: s.selected }, 'selecting.next')
        if (e.type === 'back') return go({ name: 'info', run: s.run, selected: s.selected }, 'selecting.back')
        return stay(s)
      case 'review':
        if (e.type === 'confirm') return block(s, s.selected, e.mail, 'review.confirm')
        if (e.type === 'back') return go({ name: 'selecting', run: s.run, selected: s.selected }, 'review.back')
        return stay(s)
      case 'blocking':
        if (isResult(e, s.run, 'rep.block')) {
          if (e.result.ok || e.result.code === 'already-done') return compose(s, s.mail, 'blocking.result.ok')
          return go({ name: 'blockFailed', run: s.run, selected: s.selected, mail: s.mail }, 'blocking.result.failed')
        }
        return stay(s)
      case 'blockFailed':
        if (e.type === 'retry') return block(s, s.selected, s.mail, 'blockFailed.retry')
        if (e.type === 'back') return go({ name: 'exit', run: s.run, to: 'back' }, 'blockFailed.back')
        return stay(s)
      case 'composing':
        if (isResult(e, s.run, 'rep.compose')) {
          if (e.result.ok) return go({ name: 'handedOver', run: s.run, mail: s.mail }, 'composing.result.opened')
          return go({ name: 'fallback', run: s.run, mail: s.mail, copied: null, copyFailed: false }, 'composing.result.unavailable')
        }
        return stay(s)
      case 'handedOver':
        if (e.type === 'openMail') return compose(s, s.mail, 'handedOver.openMail')
        if (e.type === 'noMailApp') return go({ name: 'fallback', run: s.run, mail: s.mail, copied: null, copyFailed: false }, 'handedOver.noMailApp')
        if (e.type === 'done' || e.type === 'back') return go({ name: 'exit', run: s.run, to: 'chat' }, 'handedOver.done')
        return stay(s)
      case 'fallback':
        if (e.type === 'copy') {
          const run = s.run + 1
          const text = e.what === 'address' ? s.mail.to : s.mail.full
          return { state: { ...s, run, copied: null, copyFailed: false }, effects: [{ id: 'rep.copy', run, what: e.what, text }], row: 'fallback.copy' }
        }
        if (isResult(e, s.run, 'rep.copy')) {
          const what = (e.result.value as 'address' | 'text' | undefined) ?? 'text'
          return go({ ...s, copied: e.result.ok ? what : null, copyFailed: !e.result.ok }, 'fallback.result.copy')
        }
        if (e.type === 'openMail') return compose(s, s.mail, 'fallback.openMail')
        if (e.type === 'done' || e.type === 'back') return go({ name: 'exit', run: s.run, to: 'chat' }, 'fallback.done')
        return stay(s)
      case 'exit':
        return stay(s)
    }
  }
  return { name: 'report', table: REPORT_TABLE, transition, sensitive: () => false }
}
