// Composition root (architecture §1): picks the adapter and the platform implementations per
// build target. The simulation is loaded only through a dynamic import behind
// VITE_TARGET === 'harness'; Vite replaces the constant, so store builds drop the branch.
// That is the intent, not the proof: scripts/check-build.mjs checks the shipped module graph.

import type { ComponentType } from 'react'
import type { AppPort } from '../port'
import type { Platform, ThemeChoice } from '../platform/ports'
import { createWebIdentityPlatform, createWebPlatform } from '../platform/web'
import { createRltpPort, unconfiguredTransport } from '../adapters/rltp'
import type { NavState } from './nav'
import type { FlowOverride } from './flow-override'

export interface Composition {
  readonly port: AppPort
  readonly platform: Platform
  readonly theme: ThemeChoice
  readonly initialNav?: NavState
  /** harness only: a flow screen with a set state (screen catalog, architecture §7.2) */
  readonly flowOverride?: FlowOverride
  /** harness only: the identity flow the app opens with */
  readonly identityStart?: 'recovery'
}

/** harness only: a page that is not one app (two phones side by side, architecture §7.3) */
export interface HarnessPage {
  readonly Root: ComponentType
}

export async function compose(): Promise<Composition | HarnessPage> {
  const target = import.meta.env.VITE_TARGET
  if (target === 'harness') {
    const { bootHarness } = await import('../../harness/boot')
    return await bootHarness(new URL(window.location.href))
  }
  // Capacitor only for the native targets: the web build does not load its chunk.
  let platform: Platform
  let identity
  if (target === 'web') {
    platform = createWebPlatform()
    identity = createWebIdentityPlatform({ clock: platform.clock, entropy: platform.entropy, prefs: platform.prefs, clipboard: platform.clipboard })
  } else {
    const cap = await import('../platform/capacitor')
    const ota = await liveUpdate()
    platform = cap.createCapacitorPlatform(ota ? { liveUpdate: ota } : {})
    identity = cap.createCapacitorIdentityPlatform(platform)
  }
  // The carrier (TSP Rev 3) joins with its transport package; until then documents wait before the trias.
  const port = createRltpPort({ identity, idb: indexedDB, transport: unconfiguredTransport(), lifecycle: platform.lifecycle })
  await port.identity.refresh()
  void platform.liveUpdate.check()
  return { port, platform, theme: 'system' }
}

/** Live update only on F-Droid (architecture §5 table; Play and App Store forbid code updates outside
 *  the store) and never with VITE_DISABLE_LIVE_UPDATE=true (legacy #238 kill switch). Vite replaces both
 *  constants, so every other build drops the import and its chunk; scripts/check-build.mjs verifies
 *  that no live-update module is in their graph. Without an update channel it stays off. */
async function liveUpdate() {
  if (import.meta.env.VITE_TARGET !== 'fdroid' || import.meta.env.VITE_DISABLE_LIVE_UPDATE === 'true') return undefined
  const channel = import.meta.env.VITE_UPDATE_CHANNEL
  if (!channel) return undefined
  const { capacitorLiveUpdate } = await import('../platform/capacitor/live-update')
  return capacitorLiveUpdate({ server: import.meta.env.VITE_UPDATE_SERVER_URL || 'https://web-of-trust.de', channel })
}
