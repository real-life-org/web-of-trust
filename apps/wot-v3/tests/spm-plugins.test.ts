// @vitest-environment node
// scripts/check-spm-plugins.sh (build-ios.sh step 4): every plugin of capacitor.config.json is in the
// Swift package that cap sync wrote, and each plugin's own Package.swift declares the product the CLI
// asks for. Runs against the real ios/App of this app and against broken fixtures. The iOS scripts use
// POSIX character classes only: macOS sed and grep do not read \s, and a pattern that matches nothing
// made the check pass without checking (CodeRabbit on #494).
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const APP = path.resolve(__dirname, '..')
const CHECK = path.join(APP, 'scripts', 'check-spm-plugins.sh')
const IOS = path.join(APP, 'ios', 'App')

function run(iosDir: string) {
  try {
    return { ok: true, out: execFileSync('bash', [CHECK, iosDir], { encoding: 'utf8', stdio: 'pipe' }) }
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string }
    return { ok: false, out: `${err.stdout ?? ''}${err.stderr ?? ''}` }
  }
}

describe('check-spm-plugins.sh', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'wot-spm-'))
  afterAll(() => rmSync(dir, { recursive: true, force: true }))

  // capacitor.config.json is what cap sync writes from capacitor.config.ts; it is not in the repository
  // (ios/.gitignore), so the tests derive it the same way: the appstore configuration
  let config: Record<string, unknown>
  beforeAll(async () => {
    process.env.VITE_TARGET = 'appstore'
    config = { ...(await import('../capacitor.config')).default } as Record<string, unknown>
  })

  /** ios/<name> has the depth of ios/App, so the committed manifest's relative plugin paths resolve */
  function fixture(name: string, edit: (pkg: string, config: Record<string, unknown>) => [string, Record<string, unknown>] = (p, c) => [p, c]) {
    const root = path.join(APP, 'ios', `.fixture-${name}`)
    const [pkg, cfg] = edit(readFileSync(path.join(IOS, 'CapApp-SPM', 'Package.swift'), 'utf8'), config)
    mkdirSync(path.join(root, 'CapApp-SPM'), { recursive: true })
    mkdirSync(path.join(root, 'App'), { recursive: true })
    writeFileSync(path.join(root, 'CapApp-SPM', 'Package.swift'), pkg)
    writeFileSync(path.join(root, 'App', 'capacitor.config.json'), JSON.stringify(cfg))
    return { app: root, cleanup: () => rmSync(root, { recursive: true, force: true }) }
  }

  it('passes on the Swift package cap sync wrote for this app, and reads every plugin package', () => {
    const f = fixture('real')
    try {
      const r = run(f.app)
      expect(r.out).toContain('8 plugins in CapApp-SPM/Package.swift, each product declared by its package')
      expect(r.ok).toBe(true)
    } finally {
      f.cleanup()
    }
  })

  it('fails when a plugin of capacitor.config.json is missing from the package', () => {
    const f = fixture('missing', (pkg, cfg) => [pkg, { ...cfg, includePlugins: [...(cfg.includePlugins as string[]), 'extra-plugin'] }])
    try {
      const r = run(f.app)
      expect(r.ok).toBe(false)
      expect(r.out).toContain('links 8 plugins, capacitor.config.ts names 9')
    } finally {
      f.cleanup()
    }
  })

  it('fails when the product the CLI asks for is not declared by the plugin', () => {
    const f = fixture('product', (pkg, cfg) => [pkg.replaceAll('"RealLifeOrgCapacitorZxingScanner"', '"CapacitorZxingScanner"'), cfg])
    try {
      const r = run(f.app)
      expect(r.ok).toBe(false)
      expect(r.out).toContain('does not declare a product named "CapacitorZxingScanner"')
    } finally {
      f.cleanup()
    }
  })

  it('fails when it reads no plugin package at all, instead of passing', () => {
    const f = fixture('none', (pkg, cfg) => [pkg.replace(/\.package\(name:[^\n]*\n/g, ''), { ...cfg, includePlugins: [] }])
    try {
      const r = run(f.app)
      expect(r.ok).toBe(false)
      expect(r.out).toContain('no plugin package')
    } finally {
      f.cleanup()
    }
  })

  it('the iOS scripts use no \\s (macOS sed and grep do not read it)', () => {
    for (const s of ['build-ios.sh', 'check-spm-plugins.sh', 'check-native-artifact.sh', 'upload-testflight.sh', 'version-from-tag.sh']) {
      expect(readFileSync(path.join(APP, 'scripts', s), 'utf8'), s).not.toMatch(/\\s/)
    }
  })
})
