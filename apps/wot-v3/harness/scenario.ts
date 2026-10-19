// Scenario format (architecture §7.1), scaffold subset: a scenario is pure data, JSON-serializable.
// Timeline, checkpoints, counterpart scripts and fault switches join with the scenario player.

import type { SimWorldSeed } from '../src/adapters/sim'
import type { IdentityFaults } from '../src/platform/fake'

export interface Scenario {
  readonly id: string
  readonly title: string
  readonly backend: 'sim' | 'loopback' | 'both'
  readonly clock: { readonly start: string; readonly timeZone: string }
  readonly view?: { readonly lang?: 'en' | 'de'; readonly theme?: 'light' | 'dark' }
  readonly world: SimWorldSeed
  /** Identity on the simulated device (architecture §7.1 `me.identity`). Without it the scenario
   *  starts unlocked without an identity runtime (the scaffold's data scenarios). */
  readonly identity?: {
    readonly state: 'none' | 'locked' | 'unlocked' | 'legacy-gen2'
    readonly protection?: 'biometric-only' | 'passphrase' | 'passphrase+biometric'
    /** biometrics changed on the device after the setup (keystore entry invalidated) */
    readonly bioInvalidated?: boolean
    readonly faults?: Partial<IdentityFaults>
    /** the flow the app opens with (recovery from the welcome screen) */
    readonly startFlow?: 'recovery'
  }
}

export function defineScenario(s: Scenario): Scenario {
  return s
}
