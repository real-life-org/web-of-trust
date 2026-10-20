// Screen catalog of report and block (architecture §7.2 "Darstellung"): every state of the report
// machine with a set state and public sample messages.
import type { FlowOverride } from '../src/app/flow-override'
import type { ReportState } from '../src/flows/report'
import { reportStates } from '../src/flows/report'
import { reportMail } from '../src/lib/report'
import type { ContactId, MessageId, MessageItem } from '../src/port'

const T = (local: string) => Date.parse(`${local}-07:00`)
const noah = 'noah' as ContactId
const msg = (id: string, text: string, at: number, mine = false): MessageItem => ({
  kind: 'message',
  id: id as MessageId,
  author: mine ? { kind: 'self' } : { kind: 'contact', contactId: noah, name: 'Noah Lindqvist' },
  text,
  at,
  origin: mine ? 'this-device' : 'received',
  delivery: mine ? { phase: 'delivered', late: false } : null,
  signed: !mine,
  selectableForReport: true,
  sentAt: at,
  receivedAt: mine ? null : at + 2000,
})

export const REPORT_SAMPLE_NAME = 'Noah Lindqvist'
export const REPORT_SAMPLE_MESSAGES: readonly MessageItem[] = [
  msg('msg:in:1', 'Great to meet you at the session!', T('2026-10-15T12:55:00')),
  msg('msg:out:1', 'Likewise.', T('2026-10-15T12:58:00'), true),
  msg('msg:in:2', 'Send me your address, now.', T('2026-10-15T13:05:00')),
  msg('msg:in:3', 'I know where you are staying.', T('2026-10-15T13:06:00')),
]

const transcriptText = [
  'Web of Trust, conversation with Noah Lindqvist (times in America/Los_Angeles)',
  '',
  'Noah Lindqvist (sent Oct 15, 2026 13:05, received Oct 15, 2026 13:05):',
  'Send me your address, now.',
  '',
  'Noah Lindqvist (sent Oct 15, 2026 13:06, received Oct 15, 2026 13:06):',
  'I know where you are staying.',
  '',
].join('\n')
const mail = reportMail({
  subject: 'Report from the app Web of Trust',
  intro: 'I am reporting messages from the app Web of Trust. The contact is blocked on my device. Conversation below.\n\nMy note: ',
  introAttached: 'I am reporting messages from the app Web of Trust. The contact is blocked on my device. The conversation is attached.\n\nMy note: ',
  transcript: transcriptText,
  fileName: 'web-of-trust-report.txt',
})
const selected = ['msg:in:2', 'msg:in:3']

const S: Record<string, ReportState> = {
  info: { name: 'info', run: 0, selected },
  selecting: { name: 'selecting', run: 0, selected },
  review: { name: 'review', run: 0, selected },
  blocking: { name: 'blocking', run: 1, selected, mail },
  blockFailed: { name: 'blockFailed', run: 1, selected, mail },
  composing: { name: 'composing', run: 2, mail },
  handedOver: { name: 'handedOver', run: 2, mail },
  fallback: { name: 'fallback', run: 2, mail, copied: null, copyFailed: false },
  'fallback-copied': { name: 'fallback', run: 3, mail, copied: 'text', copyFailed: false },
}

export const REPORT_CATALOG: readonly { readonly id: string; readonly override: FlowOverride }[] = Object.entries(S).map(([id, state]) => ({
  id: `report-${id}`,
  override: { flow: 'report', state },
}))

export const REPORT_CATALOG_STATES: readonly string[] = [...new Set(Object.values(S).map((s) => s.name))]
export { reportStates }
