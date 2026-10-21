// Scenario format (architecture §7.1), subset: a scenario is pure data, JSON-serializable.
// The scenario player (harness.html, §7.3) adds the devices beside "me" (`phones`) and the
// timeline. Checkpoints and counterpart scripts follow with the flows that need them.

import type { SimWorldSeed, WorldAction } from '../src/adapters/sim'
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

  /** Devices in the player, phone 0 first. Each phone runs its own scenario (its own holder and
   *  world); `person` is the id under which the other phones know its owner. Without it the
   *  player shows 1 to 3 independent devices of this scenario. */
  readonly phones?: readonly PhoneSpec[]
  /** Steps the player plays in order (§7.1 `timeline`); `at` is the offset to the previous step. */
  readonly timeline?: readonly Step[]
}

export interface PhoneSpec {
  readonly label: string
  readonly scenario: string
  readonly person: string
}

/** The player's fault buttons (subset of §3.2 FaultSwitches, applied to every phone). */
export interface PlayerFaults {
  /** the shared simulated transport: down queues every delivery until it is up again */
  readonly transport: 'up' | 'down'
  /** every write transaction of the seed vault aborts */
  readonly vault: 'ok' | 'fails'
  /** the keystore reports no biometrics */
  readonly biometric: 'ok' | 'unavailable'
  /** the holder host's close (S5) throws */
  readonly hostClose: 'ok' | 'fails'
  /** the camera: permission denied, or no camera on the device */
  readonly camera: 'ok' | 'denied' | 'unavailable'
  /** the share sheet and the mail app do not open (SharePort 'unsupported', MailPort 'unavailable') */
  readonly share: 'ok' | 'fails'
  /** the storage is full: StorageGuardPort.space() is 'low' and every vault write aborts (QuotaExceededError) */
  readonly storage: 'ok' | 'full'
}

export const NO_FAULTS: PlayerFaults = { transport: 'up', vault: 'ok', biometric: 'ok', hostClose: 'ok', camera: 'ok', share: 'ok', storage: 'ok' }

/** One timeline step. `at` is an offset like '+2s', '+5m', '+1h', '+1d' (virtual time). */
export type Step =
  /** a world action on one phone (default phone 0) */
  | { readonly at: string; readonly note?: string; readonly phone?: number; readonly world: WorldAction }
  /** a message from the owner of phone `from` to the owner of phone `to`, over the shared transport */
  | { readonly at: string; readonly note?: string; readonly send: { readonly from: number; readonly to: number; readonly text: string } }
  | { readonly at: string; readonly note?: string; readonly fault: Partial<PlayerFaults> }

export function defineScenario(s: Scenario): Scenario {
  return s
}
