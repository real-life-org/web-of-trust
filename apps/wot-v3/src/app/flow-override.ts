// Harness only (architecture §7.2 screen catalog): a flow screen with a set machine state, no effects.
// A plain module (no JSX) so the harness catalog and the Playwright specs can import the type.
import type { DeleteState } from '../flows/delete'
import type { LegacyState } from '../flows/legacy-reset'
import type { ProtectionState } from '../flows/protection'
import type { SetupState } from '../flows/setup'
import type { UnlockState } from '../flows/unlock'
import type { VerifyState } from '../flows/verify'
import type { ReportState } from '../flows/report'

export type Hint = 'setup-interrupted' | 'access-missing' | null

export type IdentityStatus = 'booting' | 'storage-blocked' | 'crypto-unavailable' | 'other-writer' | 'restore-switch'

export type FlowOverride =
  | { readonly flow: 'onboarding'; readonly state: SetupState; readonly hint?: Hint; readonly captured?: boolean }
  | { readonly flow: 'recovery'; readonly state: SetupState; readonly captured?: boolean }
  | { readonly flow: 'unlock'; readonly state: UnlockState; readonly notice?: 'background-timeout' | null }
  | { readonly flow: 'protection'; readonly state: ProtectionState }
  | { readonly flow: 'delete'; readonly state: DeleteState }
  | { readonly flow: 'legacy'; readonly state: LegacyState }
  | { readonly flow: 'status'; readonly status: IdentityStatus }
  | { readonly flow: 'verify'; readonly state: VerifyState }
  /** the confirmation and the success as sheets over the app (handshake UX artboards 1c, 1d, 2b):
   *  the shell shows them from the incoming queue and the success watcher, the catalog with set values */
  | {
      readonly flow: 'verifySheet'
      readonly sheet: 'confirm'
      readonly name: string
      readonly when: 'now' | 'met'
      readonly position: { readonly n: number; readonly m: number } | null
      readonly failed: boolean
    }
  | { readonly flow: 'verifySheet'; readonly sheet: 'mutual'; readonly name: string }
  /** the report screens with public sample messages (harness/catalog-report.ts) */
  | { readonly flow: 'report'; readonly state: ReportState; readonly blocked?: boolean }

