// The live-update client (platform/capacitor/live-update.ts). What decides whether a bundle is taken
// stands in a signed envelope (app, channel, bundle id, sequence, checksum, minNative), verified against
// the shell's public key before anything is downloaded (#526): a manifest host can neither lower the
// minimum shell, nor hand one platform the other's bundle, nor relabel or replay an older bundle. The
// plugin then checks the zip against the checksum from the envelope, and only against that (no zip
// signature: with a plugin publicKey the plugin would skip the checksum, see tests/native-shell.test.ts).
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

const plugin = vi.hoisted(() => ({
  ready: vi.fn(async () => ({})),
  getCurrentBundle: vi.fn(async () => ({ bundleId: null as string | null })),
  downloadBundle: vi.fn(async (options: unknown) => void options),
  setNextBundle: vi.fn(async (options: unknown) => void options),
}))
vi.mock('@capawesome/capacitor-live-update', () => ({ LiveUpdate: plugin }))

import { capacitorLiveUpdate, fitsShell } from '../../src/platform/capacitor/live-update'

const APP = 'org.reallife.weboftrust'
const CHECKSUM = 'a'.repeat(64)
let publicKey = ''
let sign: (text: string) => Promise<string>
let otherSign: (text: string) => Promise<string>

const b64 = (buf: ArrayBuffer) => Buffer.from(buf).toString('base64')
const ALG = { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }

beforeAll(async () => {
  const pair = await crypto.subtle.generateKey(ALG, true, ['sign', 'verify'])
  const spki = b64(await crypto.subtle.exportKey('spki', pair.publicKey))
  publicKey = `-----BEGIN PUBLIC KEY-----\n${spki.match(/.{1,64}/g)!.join('\n')}\n-----END PUBLIC KEY-----`
  sign = async (text) => b64(await crypto.subtle.sign('RSASSA-PKCS1-v1_5', pair.privateKey, new TextEncoder().encode(text)))
  const other = await crypto.subtle.generateKey(ALG, true, ['sign', 'verify'])
  otherSign = async (text) => b64(await crypto.subtle.sign('RSASSA-PKCS1-v1_5', other.privateKey, new TextEncoder().encode(text)))
})

type Env = { app: string; channel: string; bundleId: string; seq: number; checksum: string; minNative: string }
const ENV: Env = { app: APP, channel: 'v3-android', bundleId: 'ota-v3-7', seq: 7, checksum: CHECKSUM, minNative: '3.2.0' }

async function manifest(env: Partial<Env> = {}, opts: { signer?: (t: string) => Promise<string>; tamper?: (e: string) => string } = {}) {
  const envelope = JSON.stringify({ ...ENV, ...env })
  const envelopeSignature = await (opts.signer ?? sign)(envelope)
  return {
    envelope: opts.tamper ? opts.tamper(envelope) : envelope,
    envelopeSignature,
    url: 'https://github.com/real-life-org/web-of-trust/releases/download/ota-v3-7/v3-android.zip',
  }
}

function client(body: unknown, native = '3.2.0', status = 200) {
  const fetch = vi.fn(async () => new Response(JSON.stringify(body), { status }))
  const lu = capacitorLiveUpdate({ server: 'https://web-of-trust.de', channel: 'v3-android', fetch, publicKey, nativeVersion: async () => native })
  return { lu, fetch }
}

beforeEach(() => {
  vi.clearAllMocks()
  plugin.getCurrentBundle.mockResolvedValue({ bundleId: null })
})

describe('live update', () => {
  it('stages a bundle whose signed envelope names this app, this channel and a fitting shell', async () => {
    const m = await manifest()
    const { lu, fetch } = client(m)
    await lu.check()
    expect(fetch).toHaveBeenCalledWith('https://web-of-trust.de/updates/v3-android/latest.json')
    expect(plugin.ready).toHaveBeenCalled()
    // the checksum the plugin checks the zip against comes from the signed envelope, and nothing else
    // is handed to the plugin: a zip signature would not bind the zip to this envelope (#526)
    expect(plugin.downloadBundle).toHaveBeenCalledWith({ bundleId: 'ota-v3-7', url: m.url, checksum: CHECKSUM })
    expect(plugin.setNextBundle).toHaveBeenCalledWith({ bundleId: 'ota-v3-7' })
  })

  it.each([
    // #526: a manifest host changes a signed field without the key
    ['a lowered minNative', async () => manifest({}, { tamper: (e) => e.replace('"3.2.0"', '"3.1.0"') })],
    ['a swapped channel', async () => manifest({}, { tamper: (e) => e.replace('v3-android', 'v3-ios') })],
    ['a relabelled bundle id', async () => manifest({}, { tamper: (e) => e.replace('ota-v3-7', 'ota-v3-9') })],
    ['a changed checksum', async () => manifest({}, { tamper: (e) => e.replace(CHECKSUM, 'b'.repeat(64)) })],
    // validly signed, but not for this shell
    ['the other platform’s channel', async () => manifest({ channel: 'v3-ios' })],
    ['another app', async () => manifest({ app: 'org.reallife.reallifestack' })],
    ['a bundle id that does not match its sequence', async () => manifest({ bundleId: 'ota-v3-8' })],
    ['a newer shell than this one', async () => manifest({ minNative: '3.3.0' })],
    ['a key that is not the shell’s', async () => manifest({}, { signer: (t) => otherSign(t) })],
    ['a checksum that is not SHA-256 hex', async () => manifest({ checksum: 'xyz' })],
  ])('takes nothing with %s', async (_, make) => {
    await client(await make()).lu.check()
    expect(plugin.downloadBundle).not.toHaveBeenCalled()
  })

  it.each([
    ['no envelope signature', (m: Record<string, unknown>) => ({ ...m, envelopeSignature: undefined })],
    ['a plain http url', (m: Record<string, unknown>) => ({ ...m, url: 'http://example.org/b.zip' })],
  ])('takes nothing with %s', async (_, edit) => {
    await client(edit(await manifest())).lu.check()
    expect(plugin.downloadBundle).not.toHaveBeenCalled()
  })

  it('never goes back: an older or the running bundle is not taken again (replay of a signed bundle)', async () => {
    plugin.getCurrentBundle.mockResolvedValue({ bundleId: 'ota-v3-7' })
    await client(await manifest()).lu.check()
    await client(await manifest({ bundleId: 'ota-v3-6', seq: 6 })).lu.check()
    expect(plugin.downloadBundle).not.toHaveBeenCalled()
    await client(await manifest({ bundleId: 'ota-v3-8', seq: 8 })).lu.check()
    expect(plugin.downloadBundle).toHaveBeenCalledTimes(1)
  })

  it('stays quiet when the server answers an error or the plugin refuses the zip', async () => {
    await client(await manifest(), '3.2.0', 404).lu.check()
    expect(plugin.downloadBundle).not.toHaveBeenCalled()
    plugin.downloadBundle.mockRejectedValueOnce(new Error('Checksum mismatch.'))
    await expect(client(await manifest()).lu.check()).resolves.toBeUndefined()
    expect(plugin.setNextBundle).not.toHaveBeenCalled()
  })
})

describe('fitsShell', () => {
  it.each([
    ['3.2.0', '3.2.0', true],
    ['3.2.0', '3.2.1', true],
    ['3.2.0', '3.10.0', true],
    ['3.2.0', '4.0.0', true],
    ['3.2.1', '3.2.0', false],
    ['3.10.0', '3.9.9', false],
    ['3.2.0', 'garbage', false],
  ])('a bundle for %s on shell %s: %s', (min, shell, ok) => {
    expect(fitsShell(min, shell)).toBe(ok)
  })
})
