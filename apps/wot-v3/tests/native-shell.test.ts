// The native shell's OTA rules (architecture §8.2 step 3 and the negative fixtures of step 4):
// capacitor.config.ts per target, and scripts/check-native-artifact.sh on synthetic APK/AAB/IPA
// archives: a store artifact with the live-update plugin must be refused, one without it passes.
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { strToU8, zipSync } from 'fflate'
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'

const APP = path.resolve(__dirname, '..')
const CHECK = path.join(APP, 'scripts', 'check-native-artifact.sh')

describe('capacitor.config.ts per target', () => {
  const env = process.env.VITE_TARGET
  afterEach(() => {
    process.env.VITE_TARGET = env
    vi.resetModules()
  })

  async function load(target: string | undefined) {
    if (target === undefined) delete process.env.VITE_TARGET
    else process.env.VITE_TARGET = target
    vi.resetModules()
    return (await import('../capacitor.config')).default
  }

  it.each(['fdroid', 'play', 'appstore'])('%s lists every plugin with live update, a nonzero readyTimeout and no plugin public key', async (target) => {
    const c = await load(target)
    expect(c.includePlugins).toEqual([
      '@capacitor/app',
      '@capacitor/clipboard',
      '@capacitor/filesystem',
      '@capacitor/keyboard',
      '@capacitor/local-notifications',
      '@capacitor/share',
      '@real-life-org/capacitor-zxing-scanner',
      'capacitor-email-composer',
      '@capawesome/capacitor-live-update',
    ])
    const lu = c.plugins?.LiveUpdate as { readyTimeout?: number; publicKey?: string }
    expect(lu.readyTimeout).toBeGreaterThan(0)
    // a plugin public key would switch off the checksum check, which binds the zip to the signed
    // envelope (#526); the envelope key is the client's (src/platform/capacitor/ota-public-key.ts)
    expect(lu).not.toHaveProperty('publicKey')
    // iOS: the web view shrinks to the space above the keyboard, so the header of a screen stays in view
    expect(c.plugins?.Keyboard).toEqual({ resize: 'native' })
    expect(c.webDir).toBe(`dist-${target}`)
  })

  it('the client verifies envelopes with the committed OTA public key', async () => {
    const { OTA_PUBLIC_KEY } = await import('../src/platform/capacitor/ota-public-key')
    expect(OTA_PUBLIC_KEY).toBe(readFileSync(path.join(APP, 'ota', 'live-update-public.pem'), 'utf8').trim())
    expect(OTA_PUBLIC_KEY).toMatch(/^-----BEGIN PUBLIC KEY-----\n[A-Za-z0-9+/=\n]+\n-----END PUBLIC KEY-----$/)
  })

  it.each([undefined, 'web', 'harness', 'Play'])('refuses the target %s', async (target) => {
    await expect(load(target)).rejects.toThrow(/VITE_TARGET must be one of fdroid, play, appstore/)
  })
})

describe('check-native-artifact.sh on synthetic artifacts', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'wot-native-'))
  afterAll(() => rmSync(dir, { recursive: true, force: true }))

  const OWN = [
    'Lcom/getcapacitor/BridgeActivity;',
    'Lorg/reallife/weboftrust/BiometricKeystorePlugin;',
    'Lorg/reallife/weboftrust/ScreenProtectionPlugin;',
    'Lorg/reallife/weboftrust/AppSettingsPlugin;',
  ]
  const LIVE_UPDATE_CLASS = 'Lio/capawesome/capacitorjs/plugins/liveupdate/LiveUpdatePlugin;'
  const SCANNER = { pkg: '@real-life-org/capacitor-zxing-scanner', classpath: 'org.reallife.capacitor.zxingscanner.ZxingScannerPlugin' }
  const LIVE_UPDATE = { pkg: '@capawesome/capacitor-live-update', classpath: 'io.capawesome.capacitorjs.plugins.liveupdate.LiveUpdatePlugin' }

  function artifact(name: string, opts: { classes?: string[]; plugins?: object[]; config?: object; kind?: 'apk' | 'aab'; dex?: boolean }) {
    const prefix = opts.kind === 'aab' ? 'base/' : ''
    const dexPath = opts.kind === 'aab' ? 'base/dex/classes.dex' : 'classes.dex'
    const files: Record<string, Uint8Array> = {
      [`${prefix}assets/capacitor.config.json`]: strToU8(JSON.stringify(opts.config ?? { appId: 'org.reallife.weboftrust', plugins: {} })),
      [`${prefix}assets/capacitor.plugins.json`]: strToU8(JSON.stringify(opts.plugins ?? [SCANNER])),
    }
    // a dex string table is enough for the check: class names as Lpackage/Class;
    if (opts.dex !== false) files[dexPath] = strToU8(`dex\n035\0${(opts.classes ?? OWN).join('\0')}\0`)
    const file = path.join(dir, `${name}.${opts.kind ?? 'apk'}`)
    writeFileSync(file, zipSync(files))
    return file
  }

  const run = (file: string, mode: string) => {
    try {
      // ANDROID_HOME unset: the check reads the dex strings, apkanalyzer is not part of this test
      const out = execFileSync('bash', [CHECK, file, mode], { encoding: 'utf8', env: { ...process.env, ANDROID_HOME: '', PATH: process.env.PATH }, stdio: 'pipe' })
      return { ok: true, out }
    } catch (e) {
      const err = e as { stdout?: string; stderr?: string }
      return { ok: false, out: `${err.stdout ?? ''}${err.stderr ?? ''}` }
    }
  }

  it.each(['apk', 'aab'] as const)('a play %s without the plugin passes no-ota', (kind) => {
    const r = run(artifact(`clean-${kind}`, { kind }), 'no-ota')
    expect(r.out).toContain('no live-update plugin')
    expect(r.ok).toBe(true)
  })

  it.each(['apk', 'aab'] as const)('a play %s with the live-update classes is refused', (kind) => {
    const r = run(artifact(`classes-${kind}`, { kind, classes: [...OWN, LIVE_UPDATE_CLASS] }), 'no-ota')
    expect(r.ok).toBe(false)
    expect(r.out).toContain('live-update plugin classes')
  })

  it('a play artifact whose configuration names LiveUpdate is refused', () => {
    const r = run(artifact('config', { config: { appId: 'org.reallife.weboftrust', plugins: { LiveUpdate: { appId: 'x' } } } }), 'no-ota')
    expect(r.ok).toBe(false)
    expect(r.out).toContain('LiveUpdate in the Capacitor configuration')
  })

  it('a play artifact that registers the plugin is refused', () => {
    const r = run(artifact('registered', { plugins: [SCANNER, LIVE_UPDATE] }), 'no-ota')
    expect(r.ok).toBe(false)
    expect(r.out).toContain('live-update plugin registered')
  })

  it.each(['apk', 'aab'] as const)('a release %s needs the plugin without a plugin public key, and a check that reads nothing fails', (kind) => {
    const signed = { appId: 'org.reallife.weboftrust', plugins: { LiveUpdate: { appId: 'org.reallife.weboftrust', readyTimeout: 10000 } } }
    expect(run(artifact(`ota-${kind}`, { kind, classes: [...OWN, LIVE_UPDATE_CLASS], plugins: [SCANNER, LIVE_UPDATE], config: signed }), 'ota').ok).toBe(true)
    // with a plugin public key the plugin skips the checksum from the signed envelope (#526)
    const keyed = { appId: 'org.reallife.weboftrust', plugins: { LiveUpdate: { appId: 'x', readyTimeout: 10000, publicKey: '-----BEGIN PUBLIC KEY-----\nAAAA\n-----END PUBLIC KEY-----' } } }
    expect(run(artifact(`ota-keyed-${kind}`, { kind, classes: [...OWN, LIVE_UPDATE_CLASS], plugins: [SCANNER, LIVE_UPDATE], config: keyed }), 'ota').out).toContain('names a publicKey')
    // without readyTimeout a broken bundle is never rolled back
    expect(run(artifact(`ota-no-timeout-${kind}`, { kind, classes: [...OWN, LIVE_UPDATE_CLASS], plugins: [SCANNER, LIVE_UPDATE], config: { appId: 'org.reallife.weboftrust', plugins: { LiveUpdate: { appId: 'x' } } } }), 'ota').out).toContain('no readyTimeout')
    expect(run(artifact(`ota-missing-${kind}`, { kind, config: signed }), 'ota').out).toContain('no live-update classes')
    expect(run(artifact('no-dex', { dex: false }), 'no-ota').out).toContain('no dex files')
    expect(run(artifact('no-own', { classes: [LIVE_UPDATE_CLASS] }), 'no-ota').out).toContain('positive control')
  })
})

describe('check-native-artifact.sh on synthetic iOS artifacts', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'wot-native-ios-'))
  afterAll(() => rmSync(dir, { recursive: true, force: true }))

  // ObjC class names and Swift module names stand in the executable as strings
  const OWN = ['CAPBridgeViewController', 'BiometricKeystorePlugin', 'ScreenProtectionPlugin', 'AppSettingsPlugin', 'CapacitorBarcodeScannerPlugin']
  const LIVE_UPDATE = ['LiveUpdatePlugin', 'CapawesomeCapacitorLiveUpdate']
  const CLASS_LIST = ['AppPlugin', 'ClipboardPlugin', 'CapacitorBarcodeScannerPlugin', 'EmailComposerPlugin']

  const timestamp = (reasons: string) =>
    `<plist><dict><key>NSPrivacyAccessedAPITypes</key><array><dict><key>NSPrivacyAccessedAPIType</key><string>NSPrivacyAccessedAPICategoryFileTimestamp</string><key>NSPrivacyAccessedAPITypeReasons</key><array>${reasons}</array></dict></array></dict></plist>`
  const MANIFEST = timestamp('<string>C617.1</string>')

  function ipa(name: string, opts: { symbols?: string[]; config?: object; app?: string; executable?: boolean; manifest?: string | false }) {
    const app = opts.app ?? 'App'
    const files: Record<string, Uint8Array> = {
      [`Payload/${app}.app/capacitor.config.json`]: strToU8(JSON.stringify(opts.config ?? { appId: 'org.reallife.weboftrust', plugins: {}, packageClassList: CLASS_LIST })),
      [`Payload/${app}.app/Info.plist`]: strToU8('<plist/>'),
    }
    if (opts.manifest !== false) files[`Payload/${app}.app/PrivacyInfo.xcprivacy`] = strToU8(opts.manifest ?? MANIFEST)
    if (opts.executable !== false) files[`Payload/${app}.app/${app}`] = strToU8(`\xcf\xfa\xed\xfe${(opts.symbols ?? OWN).join('\0')}\0`)
    const file = path.join(dir, `${name}.ipa`)
    writeFileSync(file, zipSync(files))
    return file
  }

  const run = (file: string, mode: string) => {
    try {
      return { ok: true, out: execFileSync('bash', [CHECK, file, mode], { encoding: 'utf8', stdio: 'pipe' }) }
    } catch (e) {
      const err = e as { stdout?: string; stderr?: string }
      return { ok: false, out: `${err.stdout ?? ''}${err.stderr ?? ''}` }
    }
  }

  it('an app-store IPA without the plugin passes no-ota', () => {
    const r = run(ipa('clean', {}), 'no-ota')
    expect(r.out).toContain('no live-update plugin')
    expect(r.ok).toBe(true)
  })

  it('an unsigned .app directory (the archive without export secrets) is checked the same way', () => {
    const app = path.join(dir, 'Unsigned.app')
    mkdirSync(app)
    writeFileSync(path.join(app, 'Unsigned'), OWN.join('\0'))
    writeFileSync(path.join(app, 'capacitor.config.json'), JSON.stringify({ appId: 'org.reallife.weboftrust', plugins: {}, packageClassList: CLASS_LIST }))
    writeFileSync(path.join(app, 'PrivacyInfo.xcprivacy'), MANIFEST)
    const r = run(app, 'no-ota')
    expect(r.out).toContain('no live-update plugin')
    expect(r.ok).toBe(true)
  })

  it.each(LIVE_UPDATE)('an IPA whose executable carries %s is refused', (symbol) => {
    const r = run(ipa(`sym-${symbol}`, { symbols: [...OWN, symbol] }), 'no-ota')
    expect(r.ok).toBe(false)
    expect(r.out).toContain('live-update plugin classes')
  })

  it('an IPA whose configuration registers or configures LiveUpdate is refused', () => {
    const registered = run(ipa('registered', { config: { appId: 'org.reallife.weboftrust', plugins: {}, packageClassList: [...CLASS_LIST, 'LiveUpdatePlugin'] } }), 'no-ota')
    expect(registered.ok).toBe(false)
    expect(registered.out).toContain('LiveUpdate in the Capacitor configuration')
    const configured = run(ipa('configured', { config: { appId: 'org.reallife.weboftrust', plugins: { LiveUpdate: { appId: 'x' } }, packageClassList: CLASS_LIST } }), 'no-ota')
    expect(configured.ok).toBe(false)
  })

  it('an IPA without the privacy manifest, the file-timestamp category or its reason C617.1 is refused', () => {
    expect(run(ipa('no-manifest', { manifest: false }), 'no-ota').out).toContain('no PrivacyInfo.xcprivacy')
    expect(run(ipa('manifest-without-timestamp', { manifest: '<plist><dict/></plist>' }), 'no-ota').out).toContain('does not declare NSPrivacyAccessedAPICategoryFileTimestamp')
    expect(run(ipa('manifest-without-reason', { manifest: timestamp('') }), 'no-ota').out).toContain('without the reason C617.1')
    expect(run(ipa('manifest-other-reason', { manifest: timestamp('<string>DDA9.1</string>') }), 'no-ota').out).toContain('without the reason C617.1')
  })

  it('a check that reads nothing fails', () => {
    expect(run(ipa('no-exe', { executable: false }), 'no-ota').out).toContain('no executable')
    expect(run(ipa('no-own', { symbols: ['CAPBridgeViewController'] }), 'no-ota').out).toContain('positive control')
    expect(run(ipa('no-scanner-class', { config: { appId: 'org.reallife.weboftrust', plugins: {}, packageClassList: ['AppPlugin'] } }), 'no-ota').out).toContain('positive control')
  })

  it('an app-store IPA with ota needs the plugin in the executable and the registry, without a plugin public key', () => {
    const lu = { LiveUpdate: { appId: 'org.reallife.weboftrust', readyTimeout: 10000 } }
    const config = { appId: 'org.reallife.weboftrust', plugins: lu, packageClassList: [...CLASS_LIST, 'LiveUpdatePlugin'] }
    expect(run(ipa('ota-ok', { symbols: [...OWN, 'LiveUpdatePlugin'], config }), 'ota').ok).toBe(true)
    expect(run(ipa('ota-no-class', { config }), 'ota').out).toContain('no live-update classes')
    expect(run(ipa('ota-unregistered', { symbols: [...OWN, 'LiveUpdatePlugin'], config: { ...config, packageClassList: CLASS_LIST } }), 'ota').out).toContain('not in packageClassList')
    const keyed = { LiveUpdate: { ...lu.LiveUpdate, publicKey: '-----BEGIN PUBLIC KEY-----\nAAAA\n-----END PUBLIC KEY-----' } }
    expect(run(ipa('ota-keyed', { symbols: [...OWN, 'LiveUpdatePlugin'], config: { ...config, plugins: keyed } }), 'ota').out).toContain('names a publicKey')
    expect(run(ipa('ota-no-timeout', { symbols: [...OWN, 'LiveUpdatePlugin'], config: { ...config, plugins: { LiveUpdate: { appId: 'x' } } } }), 'ota').out).toContain('no readyTimeout')
  })
})
