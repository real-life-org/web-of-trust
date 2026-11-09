// Over-the-air web bundles (@capawesome/capacitor-live-update) in every native build (fdroid, play,
// appstore; never web). Loaded only through the dynamic import in app/compose.ts behind a native target
// and VITE_DISABLE_LIVE_UPDATE !== 'true' (scripts/check-build.mjs).
//
// Everything that decides whether a bundle is taken stands in a signed envelope: app, channel, bundle
// id, sequence, the zip's SHA-256 checksum and minNative (the oldest shell it runs on). The signing
// service signs the envelope's exact text with the OTA key (RSA, PKCS#1 v1.5 over SHA-256); the client
// verifies it against the public key the build was made with (ota/live-update-public.pem) before it
// downloads anything (#526). So a manifest host cannot lower minNative, hand this platform the other
// platform's bundle, relabel a bundle or replay an older one: the sequence only goes up. The plugin
// then recomputes the zip's checksum from the envelope and verifies the zip's own signature against
// the same key in the shell configuration. The shell sets a nonzero `readyTimeout`: a bundle that never
// reaches check() is rolled back. A new bundle is applied at the next start, never under a running
// session.

import { App } from '@capacitor/app'
import { LiveUpdate } from '@capawesome/capacitor-live-update'
import { OTA_PUBLIC_KEY } from './ota-public-key'
import type { LiveUpdatePort } from '../ports'

const APP_ID = 'org.reallife.weboftrust'
const SEMVER = /^(\d+)\.(\d+)\.(\d+)$/
const SHA256_HEX = /^[0-9a-f]{64}$/
const BUNDLE_ID = /^ota-v3-(\d+)$/

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

/** the sequence of a live-update bundle id (ota-v3-<n>), 0 for the shipped bundle or anything else */
function sequenceOf(bundleId: string | null | undefined): number {
  const m = BUNDLE_ID.exec(bundleId ?? '')
  return m ? Number(m[1]) : 0
}

interface Envelope {
  readonly app: string
  readonly channel: string
  readonly bundleId: string
  readonly seq: number
  readonly checksum: string
  readonly minNative: string
}

function bytesOfBase64(text: string): Uint8Array<ArrayBuffer> {
  const bin = atob(text)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

async function importKey(pem: string): Promise<CryptoKey> {
  const body = pem.replace(/-----(BEGIN|END) PUBLIC KEY-----/g, '').replace(/\s+/g, '')
  return crypto.subtle.importKey('spki', bytesOfBase64(body), { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify'])
}

/** the envelope, when its signature verifies under `key` and its fields are well formed; null otherwise */
async function verifiedEnvelope(raw: unknown, key: CryptoKey): Promise<Envelope | null> {
  if (!raw || typeof raw !== 'object') return null
  const { envelope, envelopeSignature } = raw as Record<string, unknown>
  if (typeof envelope !== 'string' || typeof envelopeSignature !== 'string' || !envelopeSignature) return null
  const ok = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, bytesOfBase64(envelopeSignature), new TextEncoder().encode(envelope))
  if (!ok) return null
  const e = JSON.parse(envelope) as Record<string, unknown>
  if (typeof e.app !== 'string' || typeof e.channel !== 'string') return null
  if (typeof e.seq !== 'number' || !Number.isSafeInteger(e.seq) || e.seq < 1) return null
  if (typeof e.bundleId !== 'string' || e.bundleId !== `ota-v3-${e.seq}`) return null
  if (typeof e.checksum !== 'string' || !SHA256_HEX.test(e.checksum)) return null
  if (typeof e.minNative !== 'string' || !SEMVER.test(e.minNative)) return null
  return { app: e.app, channel: e.channel, bundleId: e.bundleId, seq: e.seq, checksum: e.checksum, minNative: e.minNative }
}

export function capacitorLiveUpdate(opts: {
  server: string
  channel: string
  fetch?: typeof fetch
  /** the PEM public key of the OTA signing key; default: the one this build was made with */
  publicKey?: string
  /** the running shell's version (major.minor.patch); default: the app's version from the OS */
  nativeVersion?: () => Promise<string>
}): LiveUpdatePort {
  const get = opts.fetch ?? globalThis.fetch.bind(globalThis)
  const nativeVersion = opts.nativeVersion ?? (async () => (await App.getInfo()).version)
  const pem = opts.publicKey ?? OTA_PUBLIC_KEY
  return {
    enabled: true,
    async check() {
      try {
        // the running bundle started: it is good, the plugin's rollback (readyTimeout) does not take
        // it back (review 432 CodeRabbit)
        await LiveUpdate.ready()
        const res = await get(`${opts.server}/updates/${opts.channel}/latest.json`)
        if (!res.ok) return
        const raw = (await res.json()) as Record<string, unknown>
        const env = await verifiedEnvelope(raw, await importKey(pem))
        if (!env) return
        // signed, and meant for this app, this channel and this shell
        if (env.app !== APP_ID || env.channel !== opts.channel) return
        if (!fitsShell(env.minNative, await nativeVersion())) return
        // never back: a bundle at or below the running one's sequence is not taken
        const current = await LiveUpdate.getCurrentBundle()
        if (env.seq <= sequenceOf(current.bundleId)) return
        // the file: where it lies is not signed (the checksum binds its bytes), its own signature is
        // checked by the plugin
        const { url, signature } = raw
        if (typeof url !== 'string' || !url.startsWith('https://')) return
        if (typeof signature !== 'string' || !signature) return
        await LiveUpdate.downloadBundle({ bundleId: env.bundleId, url, checksum: env.checksum, signature })
        await LiveUpdate.setNextBundle({ bundleId: env.bundleId })
      } catch {
        // no network, no server, a manifest that does not parse, or a bundle the plugin refused
        // (checksum, signature): the running bundle stays
      }
    },
  }
}
