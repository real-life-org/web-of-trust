// Over-the-air web bundles (architecture §5 table: @capawesome/capacitor-live-update, target fdroid
// only; legacy apps/demo/src/live-update.ts). Loaded only through the dynamic import in app/compose.ts
// behind VITE_TARGET === 'fdroid' and VITE_DISABLE_LIVE_UPDATE !== 'true': the Play and App Store
// bundles contain none of it (scripts/check-build.mjs).

import { LiveUpdate } from '@capawesome/capacitor-live-update'
import type { LiveUpdatePort } from '../ports'

export function capacitorLiveUpdate(opts: { server: string; channel: string; fetch?: typeof fetch }): LiveUpdatePort {
  const get = opts.fetch ?? globalThis.fetch.bind(globalThis)
  return {
    enabled: true,
    async check() {
      try {
        const res = await get(`${opts.server}/updates/${opts.channel}/latest.json`)
        if (!res.ok) return
        const { bundleId, url } = (await res.json()) as { bundleId?: unknown; url?: unknown }
        if (typeof bundleId !== 'string' || typeof url !== 'string' || !url.startsWith('https://')) return
        const current = await LiveUpdate.getCurrentBundle()
        if (current.bundleId === bundleId) return
        await LiveUpdate.downloadBundle({ bundleId, url })
        await LiveUpdate.setNextBundle({ bundleId })
        // applied at the next start, never under a running session (no reload mid-use)
      } catch {
        // no network or no server: the shipped bundle stays
      }
    },
  }
}
