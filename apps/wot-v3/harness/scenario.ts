// Scenario format (architecture §7.1), scaffold subset: a scenario is pure data, JSON-serializable.
// Timeline, checkpoints, counterpart scripts and fault switches join with the scenario player.

import type { SimWorldSeed } from '../src/adapters/sim'

export interface Scenario {
  readonly id: string
  readonly title: string
  readonly backend: 'sim' | 'loopback' | 'both'
  readonly clock: { readonly start: string; readonly timeZone: string }
  readonly view?: { readonly lang?: 'en' | 'de'; readonly theme?: 'light' | 'dark' }
  readonly world: SimWorldSeed
}

export function defineScenario(s: Scenario): Scenario {
  return s
}
