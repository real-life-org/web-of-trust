// The app's own native plugins (apps/wot-v3/android: BiometricKeystore, AppSettings, ScreenProtection)
// against doubles of their JS interface: what the TS side sends and how it reads the native answers.
// Whether the Java side answers like the doubles is checked on the device (PR text "on the device").
import { beforeEach, describe, expect, it, vi } from 'vitest'

const core = vi.hoisted(() => ({
  available: new Set<string>(),
  platform: 'android',
  opened: [] as unknown[],
  openFails: false,
}))

vi.mock('@capacitor/core', () => ({
  Capacitor: {
    isPluginAvailable: (name: string) => core.available.has(name),
    getPlatform: () => core.platform,
    isNativePlatform: () => true,
  },
  registerPlugin: (name: string) => {
    if (name !== 'AppSettings') throw new Error(`unexpected plugin ${name}`)
    return {
      open: async (o: unknown) => {
        if (core.openFails) throw new Error('No settings page')
        core.opened.push(o)
      },
    }
  },
}))
vi.mock('@real-life-org/capacitor-zxing-scanner', () => ({
  CapacitorBarcodeScanner: { scanBarcode: async () => ({ ScanResult: '' }) },
  CapacitorBarcodeScannerTypeHint: { QR_CODE: 0 },
  CapacitorBarcodeScannerCameraDirection: { BACK: 1 },
  CapacitorBarcodeScannerAndroidScanningLibrary: { ZXING: 'zxing' },
}))

import { aliasOf, capacitorBiometric, type BiometricKeystorePlugin } from '../../src/platform/capacitor/biometric'
import { openAppSettings } from '../../src/platform/capacitor/scanner'
import { capacitorLanguage } from '../../src/platform/capacitor/language'
import { capacitorScreenProtection, type ScreenProtectionPlugin } from '../../src/platform/capacitor/index'

/** A double of the native BiometricKeystore: one entry per alias, the legacy entry without alias. */
function keystore() {
  const entries = new Map<string, string>()
  const calls: { method: string; options: unknown }[] = []
  let failNext: string | null = null
  const fail = () => {
    const code = failNext
    failNext = null
    if (code) throw Object.assign(new Error(code), { code })
  }
  const key = (o?: { alias?: string }) => o?.alias ?? 'wot_biometric_key'
  const plugin: BiometricKeystorePlugin = {
    isAvailable: async () => ({ available: true, biometryType: 'available' }),
    async storePassphrase(o) {
      calls.push({ method: 'store', options: o })
      fail()
      entries.set(key(o), o.passphrase)
    },
    async unlockPassphrase(o) {
      calls.push({ method: 'unlock', options: o })
      fail()
      const v = entries.get(key(o))
      if (v === undefined) throw Object.assign(new Error('No stored entry'), { code: 'KEY_NOT_FOUND' })
      return { passphrase: v }
    },
    async deletePassphrase(o) {
      calls.push({ method: 'delete', options: o })
      fail()
      entries.delete(key(o))
    },
    async hasStoredPassphrase(o) {
      calls.push({ method: 'has', options: o })
      return { stored: entries.has(key(o)) }
    },
  }
  return { plugin, entries, calls, failWith: (code: string) => void (failNext = code) }
}

describe('BiometricKeystore: one entry per namespace', () => {
  it('stores, finds and reads each namespace under its own alias, never the legacy one', async () => {
    const ks = keystore()
    const bio = capacitorBiometric(ks.plugin)
    const a = new Uint8Array([1, 2, 3, 250])
    const b = new Uint8Array([9, 9])
    expect(await bio.store('n01', a, { title: 'Unlock', subtitle: 'Confirm', cancel: 'Cancel' })).toEqual({ ok: true })
    expect(await bio.store('n02', b, { title: 'Unlock', subtitle: 'Confirm', cancel: 'Cancel' })).toEqual({ ok: true })
    expect([...ks.entries.keys()].sort()).toEqual([aliasOf('n01'), aliasOf('n02')])
    expect(ks.calls[0]).toEqual({ method: 'store', options: expect.objectContaining({ alias: 'wot_v3_n01', title: 'Unlock', subtitle: 'Confirm' }) })
    expect(await bio.hasEntry('n01')).toBe(true)
    expect(await bio.hasLegacy()).toBe(false)
    const r = await bio.retrieve('n01', { title: 'Unlock', subtitle: 'Confirm', cancel: 'Cancel' })
    expect(r.ok && [...r.secret]).toEqual([1, 2, 3, 250])
    expect(await bio.remove('n01')).toEqual({ ok: true })
    expect(await bio.hasEntry('n01')).toBe(false)
    expect(await bio.hasEntry('n02')).toBe(true)
  })

  it('reaches the Gen-2 entry only without alias', async () => {
    const ks = keystore()
    ks.entries.set('wot_biometric_key', 'legacy')
    const bio = capacitorBiometric(ks.plugin)
    expect(await bio.hasLegacy()).toBe(true)
    expect(await bio.hasEntry('n01')).toBe(false)
    expect(await bio.removeLegacy()).toEqual({ ok: true })
    expect(ks.calls.filter((c) => c.method === 'delete')).toEqual([{ method: 'delete', options: undefined }])
  })

  it.each([
    ['KEY_INVALIDATED', 'invalidated'],
    ['USER_CANCELLED', 'cancelled'],
    ['KEY_NOT_FOUND', 'missing'],
    ['AUTH_FAILED', 'failed'],
    ['INVALID_ARGUMENT', 'failed'],
  ])('reads the native code %s on unlock as %s', async (code, want) => {
    const ks = keystore()
    ks.entries.set(aliasOf('n01'), 'AQID')
    const bio = capacitorBiometric(ks.plugin)
    ks.failWith(code)
    expect(await bio.retrieve('n01', { title: 't', subtitle: 's', cancel: 'c' })).toEqual({ ok: false, code: want })
  })

  it('reports a missing entry without asking the person', async () => {
    const ks = keystore()
    const bio = capacitorBiometric(ks.plugin)
    expect(await bio.retrieve('n03', { title: 't', subtitle: 's', cancel: 'c' })).toEqual({ ok: false, code: 'missing' })
  })

  it('reads a cancelled setup as cancelled and anything else as failed', async () => {
    const ks = keystore()
    const bio = capacitorBiometric(ks.plugin)
    ks.failWith('USER_CANCELLED')
    expect(await bio.store('n01', new Uint8Array([1]), { title: 't', subtitle: 's', cancel: 'c' })).toEqual({ ok: false, code: 'cancelled' })
    ks.failWith('AUTH_FAILED')
    expect(await bio.store('n01', new Uint8Array([1]), { title: 't', subtitle: 's', cancel: 'c' })).toEqual({ ok: false, code: 'failed' })
    expect(ks.entries.size).toBe(0)
  })

  it('reports a removal as not done when the delete resolved but the entry is still there', async () => {
    const ks = keystore()
    ks.entries.set(aliasOf('n01'), 'AQ==')
    const bio = capacitorBiometric({ ...ks.plugin, deletePassphrase: async () => undefined })
    expect(await bio.remove('n01')).toEqual({ ok: false })
    ks.entries.set('wot_biometric_key', 'legacy')
    const legacy = capacitorBiometric({ ...ks.plugin, deletePassphrase: async () => undefined })
    expect(await legacy.removeLegacy()).toEqual({ ok: false })
  })

  it('reports a removal that left the entry as not done', async () => {
    const ks = keystore()
    ks.entries.set(aliasOf('n01'), 'AQ==')
    const bio = capacitorBiometric(ks.plugin)
    ks.failWith('AUTH_FAILED')
    expect(await bio.remove('n01')).toEqual({ ok: false })
  })
})

describe('AppSettings', () => {
  beforeEach(() => {
    core.available = new Set(['AppSettings'])
    core.platform = 'android'
    core.opened = []
    core.openFails = false
  })

  it('opens the app page, or the per-app language page from the language port', async () => {
    expect(await openAppSettings()).toBe(true)
    const lang = capacitorLanguage({ onState: () => () => undefined }, () => ['de'])
    await lang.openSystemSettings()
    expect(core.opened).toEqual([{ page: 'app' }, { page: 'language' }])
  })

  it('reports false when the plugin finds no page or is not registered on Android', async () => {
    core.openFails = true
    expect(await openAppSettings()).toBe(false)
    core.available = new Set()
    expect(await openAppSettings('language')).toBe(false)
    expect(core.opened).toEqual([])
  })
})

describe('ScreenProtection', () => {
  function native() {
    const calls: unknown[] = []
    const plugin: ScreenProtectionPlugin = {
      setSecure: async (o) => void calls.push(['secure', o.secure]),
      setCoverInBackground: async (o) => void calls.push(['cover', o.on]),
      addListener: async () => ({ remove: async () => undefined }),
    }
    return { plugin, calls }
  }

  it('sets FLAG_SECURE only on sensitive screens and the cover for the app switcher', () => {
    const n = native()
    const screen = capacitorScreenProtection(() => n.plugin)
    screen.set('sensitive')
    screen.set('normal')
    screen.coverInBackground(true)
    screen.coverInBackground(false)
    expect(n.calls).toEqual([
      ['secure', true],
      ['secure', false],
      ['cover', true],
      ['cover', false],
    ])
  })

  it.each([
    ['not registered', (): ScreenProtectionPlugin | null => null],
    ['registered', (): ScreenProtectionPlugin | null => native().plugin],
  ] as const)('keeps the web cover when the plugin is %s', (_name, plugin) => {
    const screen = capacitorScreenProtection(plugin)
    const covered = () => document.querySelector('[data-screen-cover]') !== null
    screen.set('sensitive')
    window.dispatchEvent(new Event('blur'))
    expect(covered()).toBe(true)
    window.dispatchEvent(new Event('focus'))
    expect(covered()).toBe(false)
    screen.set('normal')
    window.dispatchEvent(new Event('blur'))
    expect(covered()).toBe(false)
    window.dispatchEvent(new Event('focus'))
  })

  it('never throws when the native call fails', async () => {
    const plugin: ScreenProtectionPlugin = {
      setSecure: () => Promise.reject(new Error('no activity')),
      setCoverInBackground: () => Promise.reject(new Error('no activity')),
      addListener: () => Promise.reject(new Error('no listener')),
    }
    const screen = capacitorScreenProtection(() => plugin)
    screen.set('sensitive')
    screen.coverInBackground(true)
    const off = screen.onCaptured(() => undefined)
    off()
    await new Promise((r) => setTimeout(r, 0))
  })
})
