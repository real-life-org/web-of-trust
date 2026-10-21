// Composition root (architecture §1): picks the adapter and the platform implementations per
// build target. The simulation is loaded only through a dynamic import behind
// VITE_TARGET === 'harness'; Vite replaces the constant, so store builds drop the branch.
// That is the intent, not the proof: scripts/check-build.mjs checks the shipped module graph.

import type { ComponentType } from 'react'
import type { AppPort } from '../port'
import type { Platform, ThemeChoice } from '../platform/ports'
import { createWebIdentityPlatform, createWebPlatform, webAppState } from '../platform/web'
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
    platform = cap.createCapacitorPlatform()
    identity = cap.createCapacitorIdentityPlatform(platform)
  }
  // The carrier (TSP Rev 3) joins with its transport package; until then documents wait before the trias.
  const port = createRltpPort({ identity, idb: indexedDB, transport: unconfiguredTransport(), lifecycle: webAppState() })
  await port.identity.refresh()
  return { port, platform, theme: 'system' }
}
