// Which identity surface the app shows for an IdentityState (architecture §4.2 boot matrix, the
// "Weiche" of legacy IdentityManagement.tsx). Pure: the identity gate in app/ follows it and keeps
// a running flow until the flow exits, even when the identity state changes underneath (an unlock
// flow still shows offerBiometric after the vault is open).

import type { IdentityState } from '../port'

export type IdentityRoute =
  | { readonly kind: 'screen'; readonly screen: 'booting' | 'storage-blocked' | 'crypto-unavailable' | 'other-writer' | 'restore-switch' }
  | { readonly kind: 'flow'; readonly flow: 'legacy-reset'; readonly resume: boolean }
  | { readonly kind: 'flow'; readonly flow: 'onboarding'; readonly hint: 'setup-interrupted' | 'access-missing' | null }
  | { readonly kind: 'flow'; readonly flow: 'unlock'; readonly mode: 'unlock' | 'resume-setup' }
  | { readonly kind: 'flow'; readonly flow: 'delete-resume' }
  | { readonly kind: 'app' }

export function routeFor(identity: IdentityState): IdentityRoute {
  switch (identity.status) {
    case 'booting':
      return { kind: 'screen', screen: 'booting' }
    case 'storage-blocked':
      return { kind: 'screen', screen: 'storage-blocked' }
    case 'crypto-unavailable':
      return { kind: 'screen', screen: 'crypto-unavailable' }
    case 'other-writer':
      return { kind: 'screen', screen: 'other-writer' }
    case 'legacy-gen2':
      return { kind: 'flow', flow: 'legacy-reset', resume: identity.resume }
    case 'none':
      return { kind: 'flow', flow: 'onboarding', hint: identity.hint }
    case 'locked':
      return { kind: 'flow', flow: 'unlock', mode: 'unlock' }
    case 'resuming':
      if (identity.step === 'setup') return { kind: 'flow', flow: 'unlock', mode: 'resume-setup' }
      if (identity.step === 'wipe') return { kind: 'flow', flow: 'delete-resume' }
      return { kind: 'screen', screen: 'restore-switch' }
    case 'unlocked':
      return { kind: 'app' }
  }
}
