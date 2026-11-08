// The live-update client (platform/capacitor/live-update.ts): it takes a bundle only when the manifest
// names its checksum and signature (the plugin verifies both against the public key in the shell) and
// when the bundle fits the running shell (minNative), and it never reloads under a running session.
import { beforeEach, describe, expect, it, vi } from 'vitest'

const plugin = vi.hoisted(() => ({
  ready: vi.fn(async () => ({})),
  getCurrentBundle: vi.fn(async () => ({ bundleId: 'old' as string | null })),
  downloadBundle: vi.fn(async (options: unknown) => void options),
  setNextBundle: vi.fn(async (options: unknown) => void options),
}))
vi.mock('@capawesome/capacitor-live-update', () => ({ LiveUpdate: plugin }))

import { capacitorLiveUpdate, fitsShell } from '../../src/platform/capacitor/live-update'

const GOOD = {
  bundleId: 'ota-v3-7',
  url: 'https://github.com/real-life-org/web-of-trust/releases/download/ota-v3-7/v3-android.zip',
  checksum: 'a'.repeat(64),
  signature: 'c2lnbmF0dXJl',
  minNative: '3.2.0',
}

function client(manifest: unknown, native = '3.2.0', status = 200) {
  const fetch = vi.fn(async () => new Response(JSON.stringify(manifest), { status }))
  const lu = capacitorLiveUpdate({ server: 'https://web-of-trust.de', channel: 'v3-android', fetch, nativeVersion: async () => native })
  return { lu, fetch }
}

beforeEach(() => {
  vi.clearAllMocks()
  plugin.getCurrentBundle.mockResolvedValue({ bundleId: 'old' })
})

describe('live update', () => {
  it('reads the channel manifest and stages a signed bundle that fits the shell, for the next start', async () => {
    const { lu, fetch } = client(GOOD)
    await lu.check()
    expect(fetch).toHaveBeenCalledWith('https://web-of-trust.de/updates/v3-android/latest.json')
    expect(plugin.ready).toHaveBeenCalled()
    expect(plugin.downloadBundle).toHaveBeenCalledWith({ bundleId: GOOD.bundleId, url: GOOD.url, checksum: GOOD.checksum, signature: GOOD.signature })
    expect(plugin.setNextBundle).toHaveBeenCalledWith({ bundleId: GOOD.bundleId })
  })

  it.each([
    ['no signature', { ...GOOD, signature: undefined }],
    ['no checksum', { ...GOOD, checksum: undefined }],
    ['a checksum that is not SHA-256 hex', { ...GOOD, checksum: 'xyz' }],
    ['no minimum shell version', { ...GOOD, minNative: undefined }],
    ['a plain http url', { ...GOOD, url: 'http://example.org/b.zip' }],
  ])('takes nothing with %s', async (_, manifest) => {
    const { lu } = client(manifest)
    await lu.check()
    expect(plugin.downloadBundle).not.toHaveBeenCalled()
  })

  it('takes nothing a newer shell is needed for', async () => {
    const { lu } = client({ ...GOOD, minNative: '3.3.0' }, '3.2.9')
    await lu.check()
    expect(plugin.downloadBundle).not.toHaveBeenCalled()
  })

  it('takes nothing when the bundle already runs, and nothing when the server answers an error', async () => {
    plugin.getCurrentBundle.mockResolvedValue({ bundleId: GOOD.bundleId })
    await client(GOOD).lu.check()
    plugin.getCurrentBundle.mockResolvedValue({ bundleId: 'old' })
    await client(GOOD, '3.2.0', 404).lu.check()
    expect(plugin.downloadBundle).not.toHaveBeenCalled()
  })

  it('stays quiet when the download is refused (a signature that does not verify)', async () => {
    plugin.downloadBundle.mockRejectedValueOnce(new Error('signature verification failed'))
    await expect(client(GOOD).lu.check()).resolves.toBeUndefined()
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
