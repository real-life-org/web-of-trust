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

  it('accepts a native store build that names its mediator (VITE_MEDIATOR_DID)', () => {
    const r = check('play-mediator')
    expect(r.output).toContain('mediator did:webvh:Qm:example.org:mediator (play, delivery hint 217/512)')
    expect(r.ok).toBe(true)
  })

  it('accepts a mediator DID whose delivery hint has exactly 512 code points (RLTP-ENC-6090)', () => {
    const r = check('play-mediator-hint-512')
    expect(r.output).toContain('delivery hint 512/512')
    expect(r.ok).toBe(true)
  })

  it('accepts live update in the F-Droid build', () => {
    const r = check('fdroid-ota')
    expect(r.output).toContain('live update allowed (fdroid)')
    expect(r.ok).toBe(true)
  })

  it.each([
    ['sim-in-graph', 'src/adapters/sim/world.ts'],
    ['fake-in-graph', 'src/platform/fake/index.ts'],
    ['sourcemap', 'source map shipped'],
    ['harness-target', 'not a store target'],
    ['marker', '__WOT_SIM__'],
    ['player-page', 'harness.html shipped'],
    // live update (OTA) only on F-Droid: Play policy forbids code from outside the store
    ['ota-in-play', 'live-update module in a play build'],
    ['ota-text-in-play', 'contains "\\"LiveUpdate'],
    // a native store build without a mediator would make every relationship of its encounters
    // uncarried for good (RLTP-VTI-1230, 1235): no hint in any card
    ['play-no-mediator', 'play build without a mediator: VITE_MEDIATOR_DID is not set'],
    ['appstore-mediator-not-did', 'appstore build: VITE_MEDIATOR_DID is not a DID'],
    // a DID so long that no card fits its delivery hint (RLTP-ENC-6090: at most 512 characters per
    // hint): every card of the build would be refused as card-invalid
    ['play-mediator-too-long', 'play build: the delivery hint for VITE_MEDIATOR_DID has'],
    ['play-mediator-hint-513', 'play build: the delivery hint for VITE_MEDIATOR_DID has 513 code points'],
    // the web build may run without a mediator, but one it names must fit a card too
    ['web-mediator-too-long', 'web build: the delivery hint for VITE_MEDIATOR_DID has 632 code points'],
  ])('rejects %s', (fixture, reason) => {
    const r = check(fixture)
    expect(r.ok).toBe(false)
    expect(r.output).toContain(reason)
  })
})
