// Native platform implementations on Capacitor (architecture §5). The only place in src/ that may
// import @capacitor/* and native plugins (enforced by .dependency-cruiser.cjs and ESLint).
//
// Not built yet: the native shell (android/, ios/) moves in with the cutover PR (architecture §8.3),
// together with the Capacitor dependencies. Planned modules, taken over from apps/demo (reuse report §1.1):
//   biometric.ts      BiometricKeystorePlugin (same plugin name, so v3 can remove the Gen-2 entry)
//   scanner.ts        @real-life-org/capacitor-zxing-scanner (no Play Services, F-Droid)
//   clipboard.ts      @capacitor/clipboard
//   lifecycle.ts      @capacitor/app: appStateChange, backButton, exitApp, appUrlOpen
//   live-update.ts    @capawesome/capacitor-live-update, only for the fdroid target
//   screen-protection.ts, notifications.ts, share.ts, language.ts

import type { Platform } from '../ports'

export class PlatformNotImplementedError extends Error {
  constructor(what: string) {
    super(`platform/capacitor: ${what} is not implemented in the scaffold`)
    this.name = 'PlatformNotImplementedError'
  }
}

export function createCapacitorPlatform(): Platform {
  throw new PlatformNotImplementedError('createCapacitorPlatform')
}
