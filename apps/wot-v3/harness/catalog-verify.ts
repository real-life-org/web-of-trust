// Screen catalog of the verify flow (architecture §7.2 "Darstellung"): every state of the verify
// machine with a set state. The codes are public sample texts (QR of a sample link), never a card;
// they have the length of a real compact link (card-link.ts), so the screens show a code of the real
// density: version 15 for the displayed card with hint, 16 for the sent card.
import type { FlowOverride } from '../src/app/flow-override'
import type { VerifyState } from '../src/flows/verify'
import { VERIFY_STATES } from '../src/flows/verify'
import type { ContactId, DecisionId } from '../src/port'

const sample = (word: string, length: number) => `https://web-of-trust.de/c#1:${word.repeat(Math.ceil(length / word.length)).slice(0, length)}`
const card = { qr: sample('HARNESSSAMPLEDISPLAYEDCARD', 522), expiresAt: Date.parse('2026-10-15T13:35:00-07:00'), card: null }
const sent = sample('HARNESSSAMPLESENTCARD', 610)
const base = { run: 1, card, mutual: [] as readonly string[] }
const noah = 'noah' as ContactId
const preview = { role: 'displayed', name: 'Noah Lindqvist', knownContact: null, self: false } as const

const S: Record<string, VerifyState> = {
  showing: { ...base, card: null, name: 'showing', error: false },
  'showing-error': { ...base, card: null, name: 'showing', error: true },
  ready: { ...base, name: 'ready', hint: null },
  'ready-next': { ...base, name: 'ready', hint: null, next: true },
  'ready-already-captured': { ...base, name: 'ready', hint: 'already-captured' },
  'ready-nothing-open': { ...base, name: 'ready', hint: 'nothing-open' },
  cameraChecking: { ...base, name: 'cameraChecking' },
  cameraExplain: { ...base, name: 'cameraExplain' },
  scanning: { ...base, name: 'scanning' },
  cameraDenied: { ...base, name: 'cameraDenied' },
  cameraUnavailable: { ...base, name: 'cameraUnavailable' },
  manualEntry: { ...base, name: 'manualEntry', text: sent },
  previewing: { ...base, name: 'previewing', raw: sent },
  'scanError-card-self': { ...base, name: 'scanError', code: 'card-self' },
  'scanError-code-expired': { ...base, name: 'scanError', code: 'code-expired' },
  'scanError-card-invalid': { ...base, name: 'scanError', code: 'card-invalid' },
  confirm: { ...base, name: 'confirm', raw: sent, preview },
  committing: { ...base, name: 'committing', preview },
  waiting: { ...base, name: 'waiting', contactId: noah, name2: 'Noah Lindqvist', waitLong: false },
  'waiting-long': { ...base, name: 'waiting', contactId: noah, name2: 'Noah Lindqvist', waitLong: true },
  loadingFallback: { ...base, name: 'loadingFallback', contactId: noah, name2: 'Noah Lindqvist' },
  fallback: { ...base, name: 'fallback', contactId: noah, name2: 'Noah Lindqvist', sentQr: sent },
  capturing: { ...base, name: 'capturing', preview: { ...preview, role: 'sent' } },
  confirmationRequired: { ...base, name: 'confirmationRequired', contactId: noah, decision: 'p-noah' as DecisionId, name2: 'Noah Lindqvist', busy: false },
  confirmIncoming: { ...base, card: null, name: 'confirmIncoming', contactId: noah, decision: 'p-noah' as DecisionId, name2: 'Noah Lindqvist', busy: false, failed: false },
  'confirmIncoming-failed': { ...base, card: null, name: 'confirmIncoming', contactId: noah, decision: 'p-noah' as DecisionId, name2: 'Noah Lindqvist', busy: false, failed: true },
  counterPending: { ...base, name: 'counterPending', contactId: noah, name2: 'Noah Lindqvist' },
  success: { ...base, name: 'success', contactId: noah, name2: 'Noah Lindqvist', isNew: true },
}

export interface VerifyCatalogEntry {
  readonly id: string
  readonly override: FlowOverride
}

const confirmSheet = (position: { n: number; m: number } | null, when: 'now' | 'met' = 'now', failed = false): FlowOverride => ({
  flow: 'verifySheet',
  sheet: 'confirm',
  name: 'Noah Lindqvist',
  when,
  position,
  failed,
})

/** the sheets of the moment (handshake UX artboards 1c, 1d, 2b): the shell's incoming queue, the
 *  conversation's fallback, the success anywhere in the app */
const SHEETS: Record<string, FlowOverride> = {
  incoming: confirmSheet(null),
  'incoming-queue': confirmSheet({ n: 2, m: 3 }),
  'incoming-failed': confirmSheet(null, 'now', true),
  met: confirmSheet(null, 'met'),
  mutual: { flow: 'verifySheet', sheet: 'mutual', name: 'Noah Lindqvist' },
}

export const VERIFY_CATALOG: readonly VerifyCatalogEntry[] = [
  ...Object.entries(S).map(([id, state]) => ({ id: `verify-${id}`, override: { flow: 'verify', state } as const })),
  ...Object.entries(SHEETS).map(([id, override]) => ({ id: `verify-sheet-${id}`, override })),
]

/** every state of the machine except `exit` has an entry (checked by tests/verify-catalog.test.tsx) */
export const VERIFY_CATALOG_STATES: readonly string[] = [...new Set(Object.values(S).map((s) => s.name))]
export { VERIFY_STATES }
