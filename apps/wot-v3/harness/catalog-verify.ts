// Screen catalog of the verify flow (architecture §7.2 "Darstellung"): every state of the verify
// machine with a set state. The codes are public sample texts (QR of a sample link), never a card.
import type { FlowOverride } from '../src/app/flow-override'
import type { VerifyState } from '../src/flows/verify'
import { VERIFY_STATES } from '../src/flows/verify'
import type { ContactId, DecisionId } from '../src/port'

const card = { qr: 'https://web-of-trust.de/c#harness-sample-displayed-card', expiresAt: Date.parse('2026-10-15T13:35:00-07:00') }
const sent = 'https://web-of-trust.de/c#harness-sample-sent-card'
const base = { run: 1, card, known: [] as readonly string[], mutual: [] as readonly string[] }
const noah = 'noah' as ContactId
const preview = { role: 'displayed', name: 'Noah Lindqvist', knownContact: null, self: false } as const

const S: Record<string, VerifyState> = {
  showing: { ...base, card: null, name: 'showing', error: false },
  'showing-error': { ...base, card: null, name: 'showing', error: true },
  ready: { ...base, name: 'ready', hint: null },
  'ready-already-captured': { ...base, name: 'ready', hint: 'already-captured' },
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
  counterPending: { ...base, name: 'counterPending', contactId: noah, name2: 'Noah Lindqvist' },
  success: { ...base, name: 'success', contactId: noah, name2: 'Noah Lindqvist', isNew: true },
}

export interface VerifyCatalogEntry {
  readonly id: string
  readonly override: FlowOverride
}

export const VERIFY_CATALOG: readonly VerifyCatalogEntry[] = Object.entries(S).map(([id, state]) => ({ id: `verify-${id}`, override: { flow: 'verify', state } }))

/** every state of the machine except `exit` has an entry (checked by tests/verify-catalog.test.tsx) */
export const VERIFY_CATALOG_STATES: readonly string[] = [...new Set(Object.values(S).map((s) => s.name))]
export { VERIFY_STATES }
