// Core refusals → port errors (architecture §2.6). One table over the complete ActError union of
// the pinned library (0.5.0): a new code in a library update is a type error here, not a silent fallback.
// Library code and rule reference go only into the diagnostic store; the port error carries the
// DiagnosticId (wiring follows with the runtime).

import type { ActError } from '@real-life/trust-protocol'
import type { AppError, RefusalCode } from '../../port'

type Mapped = { readonly refused: RefusalCode } | { readonly bug: true }

const r = (code: RefusalCode): Mapped => ({ refused: code })
const BUG: Mapped = { bug: true }
const GENERIC = r('not-possible-yet')

export const ACT_ERRORS = {
  'card-invalid': r('card-invalid'),
  'already-scanned': r('already-scanned'),
  'gate-expired': r('code-expired'),
  'gate-future': r('code-expired'),
  'stale-issuance': r('code-expired'),
  'consumed-challenge': r('code-used'),
  'card-mismatch': r('code-used'),
  'no-record': r('nothing-to-counter'),
  'already-issued': r('already-done'),
  'unknown-prompt': r('decision-gone'),
  'prompt-expired': r('decision-expired'),
  'already-given': r('already-done'),
  'in-flight': r('in-flight'),
  'actid-conflict': BUG,
  'actid-missing': BUG,
  'log-missing': BUG,
  'unknown-group': r('unknown-group'),
  'no-evidence': r('not-possible-yet'),
  'own-admission': r('not-possible-yet'),
  'threshold-unsupported': r('not-possible-yet'),
  'profile-invalid': r('profile-invalid'),
  'unknown-contact': r('unknown-contact'),
  // Message Tasks 0.1 (lib 0.5.0): the app keeps an unsent message on these (PR messages)
  blocked: r('contact-blocked'),
  'not-ready': r('not-ready'),
  'message-invalid': r('message-invalid'),
  // the rest: generic "not possible yet"
  'no-own-channel': GENERIC,
  'tuple-deactivated': GENERIC,
  'scope-exhausted': GENERIC,
  'no-community': GENERIC,
  'unknown-digest': GENERIC,
  'not-mergeable': GENERIC,
  'device-name-invalid': GENERIC,
  'device-name-held': GENERIC,
  'device-name-revoked': GENERIC,
  'unknown-device': GENERIC,
  'log-behind': GENERIC,
  'log-diverged': GENERIC,
  'log-failure': GENERIC,
  'unknown-act': GENERIC,
  'no-declaration': GENERIC,
} as const satisfies Record<ActError, Mapped>

export function mapActError(code: ActError): AppError {
  const m: Mapped = ACT_ERRORS[code]
  return 'bug' in m ? { kind: 'bug', message: `core refused with ${code}` } : { kind: 'refused', code: m.refused }
}
