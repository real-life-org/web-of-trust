// The harness page as the simulated device (build target "harness" only): browser back is the
// system back of the device, and `window.__wotDevice` drives app state, back, clock and the iOS
// screenshot notification for the Playwright platform specs (e2e/platform.spec.ts).

import { webLifecycle } from '../src/platform/web'
import type { createFakePlatform, VirtualClock } from '../src/platform/fake'

type FakePlatform = ReturnType<typeof createFakePlatform>

declare global {
  interface Window {
    /** harness only: the simulated device under the app (e2e/platform.spec.ts) */
    __wotDevice?: {
      background(): void
      foreground(): void
      /** the system back; false = no handler took it (the app was left) */
      back(): boolean
      advance(ms: number): void
      /** an iOS screenshot notification */
      capture(): void
      exits(): number
    }
  }
}

export function exposeDevice(fake: FakePlatform, clock: VirtualClock): void {
  if (typeof window === 'undefined') return
  webLifecycle().onBack(() => fake.lifecycle.back())
  window.__wotDevice = {
    background: () => fake.lifecycle.emit('background'),
    foreground: () => fake.lifecycle.emit('active'),
    back: () => fake.lifecycle.back(),
    advance: (ms) => clock.advance(ms),
    capture: () => fake.screen.capture(),
    exits: () => fake.lifecycle.exits,
  }
}

