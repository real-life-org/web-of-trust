// @vitest-environment node
// The iOS shell (ios/, architecture §8.3) against what the app and the release path expect: the
// Xcode project names the app the Android shell builds, the own plugins exist in Swift with the
// methods the TypeScript side calls, every plugin of capacitor.config.ts is in the generated Swift
// package, the version comes from the tag as on Android, and the workflow's secrets are the ones the
// deploy README documents (a hand-written list drifts silently).
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const here = (...p: string[]) => resolve(__dirname, '..', ...p)
const read = (...p: string[]) => readFileSync(here(...p), 'utf8')

const pbxproj = read('ios/App/App.xcodeproj/project.pbxproj')
const infoPlist = read('ios/App/App/Info.plist')
const storyboard = read('ios/App/App/Base.lproj/Main.storyboard')
const entitlements = read('ios/App/App/App.entitlements')
const packageSwift = read('ios/App/CapApp-SPM/Package.swift')
const versionName = /^VERSION_NAME=(\d+)\.(\d+)\.(\d+)$/m.exec(read('android/version.properties'))!

/** the SPM product the Capacitor CLI writes for an npm plugin (its Package.swift) */
const SPM_PRODUCTS: Record<string, string> = {
  '@capacitor/app': 'CapacitorApp',
  '@capacitor/clipboard': 'CapacitorClipboard',
  '@capacitor/filesystem': 'CapacitorFilesystem',
  '@capacitor/local-notifications': 'CapacitorLocalNotifications',
  '@capacitor/share': 'CapacitorShare',
  '@real-life-org/capacitor-zxing-scanner': 'CapacitorZxingScanner',
  'capacitor-email-composer': 'CapacitorEmailComposer',
}

describe('Xcode project', () => {
  it('builds org.reallife.weboftrust in both configurations, with the entitlements and no fixed team', () => {
    const ids = [...pbxproj.matchAll(/PRODUCT_BUNDLE_IDENTIFIER = ([^;]+);/g)].map((m) => m[1])
    expect(ids).toEqual(['org.reallife.weboftrust', 'org.reallife.weboftrust'])
    expect(pbxproj.match(/CODE_SIGN_ENTITLEMENTS = App\/App\.entitlements;/g)).toHaveLength(2)
    // the team is Tillmann's account: the release build passes it (IOS_TEAM_ID), a developer's Xcode sets its own
    expect(pbxproj).not.toMatch(/DEVELOPMENT_TEAM = \S/)
  })

  it('compiles the view controller and the three own plugins', () => {
    const sources = pbxproj.slice(pbxproj.indexOf('/* Begin PBXSourcesBuildPhase section */'), pbxproj.indexOf('/* End PBXSourcesBuildPhase section */'))
    for (const f of ['AppDelegate.swift', 'MyViewController.swift', 'BiometricKeystorePlugin.swift', 'ScreenProtectionPlugin.swift', 'AppSettingsPlugin.swift']) {
      expect(sources).toContain(`${f} in Sources`)
    }
    expect(storyboard).toContain('customClass="MyViewController" customModule="App"')
  })

  it('carries the version of android/version.properties with the build number of the Android formula', () => {
    const [, mj, mn, pt] = versionName.map(Number) as unknown as [string, number, number, number]
    const marketing = [...pbxproj.matchAll(/MARKETING_VERSION = ([^;]+);/g)].map((m) => m[1])
    const build = [...pbxproj.matchAll(/CURRENT_PROJECT_VERSION = ([^;]+);/g)].map((m) => m[1])
    expect(marketing).toEqual([versionName[0]!.slice('VERSION_NAME='.length), versionName[0]!.slice('VERSION_NAME='.length)])
    expect(build).toEqual([String(mj * 10000 + mn * 100 + pt), String(mj * 10000 + mn * 100 + pt)])
  })

  it('localizes the permission texts in English and German', () => {
    for (const key of ['NSCameraUsageDescription', 'NSFaceIDUsageDescription']) {
      expect(infoPlist).toContain(`<key>${key}</key>`)
      expect(read('ios/App/App/en.lproj/InfoPlist.strings')).toMatch(new RegExp(`^"${key}" = ".+";$`, 'm'))
      expect(read('ios/App/App/de.lproj/InfoPlist.strings')).toMatch(new RegExp(`^"${key}" = ".+";$`, 'm'))
    }
    expect(infoPlist).toMatch(/<key>CFBundleLocalizations<\/key>\s*<array>\s*<string>en<\/string>\s*<string>de<\/string>\s*<\/array>/)
    expect(pbxproj).toContain('InfoPlist.strings in Resources')
    expect(pbxproj).toContain('path = de.lproj/InfoPlist.strings')
    expect(pbxproj).toContain('path = en.lproj/InfoPlist.strings')
  })

  it('ships the privacy manifest with the reasons of the filesystem plugin and the bridge', () => {
    const manifest = read('ios/App/App/PrivacyInfo.xcprivacy')
    expect(manifest).toContain('<string>NSPrivacyAccessedAPICategoryFileTimestamp</string>')
    expect(manifest).toContain('<string>C617.1</string>')
    expect(manifest).toContain('<string>NSPrivacyAccessedAPICategoryUserDefaults</string>')
    expect(manifest).toContain('<string>CA92.1</string>')
    expect(manifest).toMatch(/<key>NSPrivacyTracking<\/key>\s*<false\/>/)
    const resources = pbxproj.slice(pbxproj.indexOf('/* Begin PBXResourcesBuildPhase section */'), pbxproj.indexOf('/* End PBXResourcesBuildPhase section */'))
    expect(resources).toContain('PrivacyInfo.xcprivacy in Resources')
  })

  it('claims the card links of web-of-trust.de (Universal Links, #489)', () => {
    expect(entitlements).toContain('<string>applinks:web-of-trust.de</string>')
  })

  it('links every plugin of capacitor.config.ts and not the live-update plugin', async () => {
    process.env.VITE_TARGET = 'appstore'
    const { PLUGINS, LIVE_UPDATE_PLUGIN } = await import('../capacitor.config')
    for (const npm of PLUGINS) {
      const product = SPM_PRODUCTS[npm]
      expect(product, `no SPM product known for ${npm}`).toBeDefined()
      expect(packageSwift, `${npm} is not in CapApp-SPM/Package.swift (cap sync ios skipped it)`).toContain(`.product(name: "${product}", package: "${product}")`)
    }
    expect(LIVE_UPDATE_PLUGIN).toBe('@capawesome/capacitor-live-update')
    expect(packageSwift).not.toMatch(/LiveUpdate/)
  })
})

describe('own plugins in Swift (src/platform/capacitor)', () => {
  const plugin = (file: string) => read('ios/App/App', file)

  it.each([
    ['BiometricKeystorePlugin.swift', 'BiometricKeystore', ['isAvailable', 'storePassphrase', 'unlockPassphrase', 'deletePassphrase', 'hasStoredPassphrase']],
    ['ScreenProtectionPlugin.swift', 'ScreenProtection', ['setSecure', 'setCoverInBackground']],
    ['AppSettingsPlugin.swift', 'AppSettings', ['open']],
  ])('%s registers as %s with the methods the app calls', (file, jsName, methods) => {
    const src = plugin(file)
    expect(src).toContain(`public let jsName = "${jsName}"`)
    for (const m of methods) {
      expect(src).toContain(`CAPPluginMethod(name: "${m}", returnType: CAPPluginReturnPromise)`)
      expect(src).toMatch(new RegExp(`@objc func ${m}\\(_ call: CAPPluginCall\\)`))
    }
    expect(read('ios/App/App/MyViewController.swift')).toContain(`registerPluginInstance(${file.replace('.swift', '')}())`)
  })

  it('the biometric plugin keeps the v3 alias contract and reaches the Gen-2 entry only to find and remove it', () => {
    const src = plugin('BiometricKeystorePlugin.swift')
    // the alias rule of BiometricPolicy.java
    expect(src).toContain('^wot_v3_[A-Za-z0-9_-]{1,120}$')
    // the Gen-2 keychain item of apps/demo
    expect(src).toContain('"org.utopialab.weboftrust.biometric"')
    expect(src).toContain('"encrypted_passphrase"')
    for (const code of ['USER_CANCELLED', 'KEY_NOT_FOUND', 'AUTH_FAILED', 'INVALID_ARGUMENT']) expect(src).toContain(`"${code}"`)
    // the screenshot event the port subscribes to
    expect(plugin('ScreenProtectionPlugin.swift')).toContain('notifyListeners("screenshotTaken"')
  })
})

describe('release path', () => {
  const script = here('scripts', 'version-from-tag.sh')
  const run = (tag: string) => {
    try {
      return { ok: true, out: execFileSync('bash', [script, tag], { encoding: 'utf8', stdio: 'pipe' }) }
    } catch (e) {
      const err = e as { stdout?: string; stderr?: string }
      return { ok: false, out: `${err.stdout ?? ''}${err.stderr ?? ''}` }
    }
  }

  it('derives version and build number from the tag like build-android.sh', () => {
    expect(run('app-v3.0.2')).toEqual({ ok: true, out: 'VERSION_NAME=3.0.2\nBUILD_NUMBER=30002\n' })
    expect(run('app-v3.12.7').out).toContain('BUILD_NUMBER=31207')
  })

  it.each([
    ['app-v2.9.9', 'Gen-2 tag'],
    ['app-v3.100.0', 'minor/patch < 100'],
    ['v3.0.0', 'does not start with'],
    ['app-v3.0', 'not major.minor.patch'],
    ['', 'usage'],
  ])('refuses %s', (tag, reason) => {
    const r = run(tag)
    expect(r.ok).toBe(false)
    expect(r.out).toContain(reason)
  })

  it('build-ios.sh enforces the Xcode minimum of Capacitor 8 and the README names the same version', () => {
    const build = read('scripts', 'build-ios.sh')
    const min = /^XCODE_MIN=(\d+)$/m.exec(build)?.[1]
    expect(min).toBe('26')
    expect(build).toContain('export DEVELOPER_DIR=')
    expect(read('../../deploy/ios/README.md')).toContain(`Xcode ${min}`)
    expect(read('../../deploy/ios/README.md')).not.toMatch(/Xcode 16\b/)
  })

  it('build-on-tag.yml has the iOS job on a macOS runner behind the same tag filter, with documented secrets', () => {
    const wf = read('../../.github/workflows/build-on-tag.yml')
    const readme = read('../../deploy/ios/README.md')
    expect(wf).toMatch(/^\s+ios:\n(?:.*\n)*?\s+runs-on: macos-/m)
    expect(wf).toContain('apps/wot-v3/scripts/build-ios.sh')
    expect(wf).toContain('name: ios-${{')
    // every secret and variable the workflow reads stands in the README's table
    const names = new Set([...wf.matchAll(/\b(?:secrets|vars)\.([A-Z0-9_]+)/g)].map((m) => m[1]!))
    expect(names.size).toBeGreaterThan(3)
    for (const n of names) expect(readme, `${n} is not documented in deploy/ios/README.md`).toContain(`\`${n}\``)
  })
})
