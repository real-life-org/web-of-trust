// Error model (architecture §2.6). Codes speak in terms of the surface: what the human can do,
// not which protocol rule applied. The core taxonomy ends in adapters/rltp/errors.ts.

import type { Brand } from './ids'
import type { UnavailableReason } from './models'

export type RefusalCode =
  // Encounter
  | 'card-invalid'
  | 'card-self'
  | 'already-scanned'
  | 'code-expired'
  | 'code-used'
  | 'nothing-to-counter'
  // Contacts, trust
  | 'unknown-contact'
  | 'already-done'
  | 'contact-blocked'
  // Messages: 'not-ready' (no document of the contact arrived on the relationship yet; the app keeps
  // the message unsent), 'message-invalid' (1 to 4096 code points)
  | 'not-ready'
  | 'message-invalid'
  // Decisions
  | 'decision-gone'
  | 'decision-expired'
  // Groups
  | 'unknown-group'
  | 'not-possible-yet'
  // Profile, input, protection
  | 'profile-invalid'
  | 'name-empty'
  | 'mnemonic-invalid'
  | 'mnemonic-checksum'
  | 'passphrase-too-short'
  | 'passphrase-wrong'
  | 'last-access'
  // Reporting
  | 'report-changed'
  // general
  | 'superseded'
  | 'in-flight'

/** Opaque reference to a diagnostic entry; the content lives only in port/diagnostics.ts. */
export type DiagnosticId = Brand<string, 'DiagnosticId'>

export type AppError =
  | { readonly kind: 'refused'; readonly code: RefusalCode; readonly diagnostic?: DiagnosticId }
  | { readonly kind: 'locked' }
  | { readonly kind: 'unavailable'; readonly reason: UnavailableReason }
  | {
      readonly kind: 'platform'
      readonly code:
        | 'camera-denied'
        | 'camera-unavailable'
        | 'biometric-cancelled'
        | 'biometric-invalidated'
        | 'biometric-unavailable'
        | 'storage-blocked'
        | 'clipboard-failed'
    }
  | {
      readonly kind: 'infra'
      readonly code: 'storage' | 'transport' | 'crypto-unavailable' | 'key-provider' | 'unknown-outcome' | 'conflict'
      readonly retryable: boolean
    }
  /** programming error, crash-screen path */
  | { readonly kind: 'bug'; readonly message: string }
