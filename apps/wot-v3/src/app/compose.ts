// Composition root (architecture §1): picks the adapter and the platform implementations per
// build target. The simulation is loaded only through a dynamic import behind
// VITE_TARGET === 'harness'; Vite replaces the constant, so store builds drop the branch.
// That is the intent, not the proof: scripts/check-build.mjs checks the shipped module graph.

import type { AppPort } from '../port'
import type { Platform, ThemeChoice } from '../platform/ports'
import { createWebPlatform } from '../platform/web'
import { createRltpPort } from '../adapters/rltp'
import type { NavState } from './nav'

export interface Composition {
  readonly port: AppPort
  readonly platform: Platform
  readonly theme: ThemeChoice
  readonly initialNav?: NavState
}

export async function compose(): Promise<Composition> {
  const target = import.meta.env.VITE_TARGET
  if (target === 'harness') {
    const { bootHarness } = await import('../../harness/boot')
    return bootHarness(new URL(window.location.href))
  }
  // Capacitor only for the native targets: the web build does not load its chunk.
  const platform = target === 'web' ? createWebPlatform() : (await import('../platform/capacitor')).createCapacitorPlatform()
  return { port: createRltpPort(platform), platform, theme: 'system' }
}
