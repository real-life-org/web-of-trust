// Over-the-air web bundles (@capawesome/capacitor-live-update) in every native build (fdroid, play,
// appstore; never web). Loaded only through the dynamic import in app/compose.ts behind a native target
// and VITE_DISABLE_LIVE_UPDATE !== 'true' (scripts/check-build.mjs).
//
// A bundle is taken only when the channel manifest names its SHA-256 checksum and its signature: the
// plugin recomputes the checksum and verifies the signature against the public key compiled into the
// shell (capacitor.config.ts, ota/live-update-public.pem), so a bundle the signing service did not sign
// never runs, whoever serves the manifest or the file. `minNative` is the oldest shell the bundle runs
// on (the last native release before its commit): a shell older than that keeps its own bundle until
// the store updates it. The shell sets a nonzero `readyTimeout`: a bundle that never reaches check() is
// rolled back. A new bundle is applied at the next start, never under a running session.

import { App } from '@capacitor/app'
import { LiveUpdate } from '@capawesome/capacitor-live-update'
import type { LiveUpdatePort } from '../ports'

const SEMVER = /^(\d+)\.(\d+)\.(\d+)$/
const SHA256_HEX = /^[0-9a-f]{64}$/

/** whether a bundle that needs shell `min` runs on shell `shell` (both major.minor.patch) */
export function fitsShell(min: string, shell: string): boolean {
  const a = SEMVER.exec(min)
  const b = SEMVER.exec(shell)
  if (!a || !b) return false
  for (let i = 1; i <= 3; i++) {
    const d = Number(b[i]) - Number(a[i])
    if (d !== 0) return d > 0
  }
  return true
}

interface Manifest {
  readonly bundleId: string
  readonly url: string
  readonly checksum: string
  readonly signature: string
  readonly minNative: string
}

function manifest(raw: unknown): Manifest | null {
  if (!raw || typeof raw !== 'object') return null
  const m = raw as Record<string, unknown>
  const { bundleId, url, checksum, signature, minNative } = m
  if (typeof bundleId !== 'string' || !bundleId) return null
  if (typeof url !== 'string' || !url.startsWith('https://')) return null
  if (typeof checksum !== 'string' || !SHA256_HEX.test(checksum)) return null
  if (typeof signature !== 'string' || !signature) return null
  if (typeof minNative !== 'string' || !SEMVER.test(minNative)) return null
  return { bundleId, url, checksum, signature, minNative }
}

export function capacitorLiveUpdate(opts: {
  server: string
  channel: string
  fetch?: typeof fetch
  /** the running shell's version (major.minor.patch); default: the app's version from the OS */
  nativeVersion?: () => Promise<string>
}): LiveUpdatePort {
  const get = opts.fetch ?? globalThis.fetch.bind(globalThis)
  const nativeVersion = opts.nativeVersion ?? (async () => (await App.getInfo()).version)
  return {
    enabled: true,
    async check() {
      try {
        // the running bundle started: it is good, the plugin's rollback (readyTimeout) does not take
        // it back (review 432 CodeRabbit)
        await LiveUpdate.ready()
        const res = await get(`${opts.server}/updates/${opts.channel}/latest.json`)
        if (!res.ok) return
        const m = manifest(await res.json())
        if (!m) return
        if (!fitsShell(m.minNative, await nativeVersion())) return
        const current = await LiveUpdate.getCurrentBundle()
        if (current.bundleId === m.bundleId) return
        await LiveUpdate.downloadBundle({ bundleId: m.bundleId, url: m.url, checksum: m.checksum, signature: m.signature })
        await LiveUpdate.setNextBundle({ bundleId: m.bundleId })
      } catch {
        // no network, no server, or a bundle the plugin refused (checksum, signature): the running
        // bundle stays
      }
    },
  }
}
