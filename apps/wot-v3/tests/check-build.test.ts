// Store-build check (architecture §8.2, step 4): the clean fixture passes, each broken one is rejected.
// @vitest-environment node
import { execFileSync } from 'node:child_process'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const root = path.resolve(__dirname, '..')
const script = path.join(root, 'scripts', 'check-build.mjs')

function check(fixture: string): { ok: boolean; output: string } {
  const dist = path.join(root, 'tests', 'build-fixtures', fixture, 'shipped')
  try {
    return { ok: true, output: execFileSync(process.execPath, [script, dist], { encoding: 'utf8', stdio: 'pipe' }) }
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string }
    return { ok: false, output: `${err.stdout ?? ''}${err.stderr ?? ''}` }
  }
}

describe('scripts/check-build.mjs', () => {
  it('accepts a clean store build', () => {
    const r = check('clean')
    expect(r.output).toContain('store-build check passed')
    expect(r.ok).toBe(true)
  })

  it.each([
    ['sim-in-graph', 'src/adapters/sim/world.ts'],
    ['fake-in-graph', 'src/platform/fake/index.ts'],
    ['sourcemap', 'source map shipped'],
    ['harness-target', 'not a store target'],
    ['marker', '__WOT_SIM__'],
    ['player-page', 'harness.html shipped'],
  ])('rejects %s', (fixture, reason) => {
    const r = check(fixture)
    expect(r.ok).toBe(false)
    expect(r.output).toContain(reason)
  })
})
