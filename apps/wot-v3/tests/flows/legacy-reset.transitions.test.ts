// Gen-2 reset (architecture §4.2 "Gen-2-Reset", Anton: new identity with a notice, no migration):
// notice once, wipe of the old databases, keys and keystore alias, marker only after a verified
// wipe, resume without the notice.
import { describe, expect, it } from 'vitest'
import { legacyReset, legacyStart, LEGACY_TABLE } from '../../src/flows/legacy-reset'
import { createFlowRunner } from '../../src/hooks/flow-runner'
import { seedLegacyGen2 } from '../../src/platform/fake'
import { drive, tableCoverage, testDevice } from './world'

const cover = tableCoverage('legacy-reset', LEGACY_TABLE)

describe('Gen-2 reset', () => {
  it('detects the old install, notice, wipe, verify, mark, then welcome', async () => {
    const d = testDevice()
    seedLegacyGen2(d.device)
    const p = await d.restart()
    expect(p.runtime.state.get()).toEqual({ status: 'legacy-gen2', resume: false })
    const r = cover.track(createFlowRunner(legacyReset, legacyStart(false), p.exec.legacy, p.platform))
    expect(r.get().name).toBe('notice')
    await drive(r, { type: 'acknowledge' })
    expect(r.get().name).toBe('exit')
    expect(d.device.legacy.databases.size + d.device.legacy.localStorage.size).toBe(0)
    expect(d.device.legacy.keystore).toBe(false)
    expect(p.runtime.state.get()).toEqual({ status: 'none', hint: null })
    expect((await d.restart()).runtime.state.get()).toEqual({ status: 'none', hint: null })
  })

  it('a survivor keeps the marker; the next start continues without the notice', async () => {
    const d = testDevice()
    seedLegacyGen2(d.device)
    d.device.faults.wipeSurvivor = 'wot-identity'
    let p = await d.restart()
    let r = cover.track(createFlowRunner(legacyReset, legacyStart(false), p.exec.legacy, p.platform))
    await drive(r, { type: 'acknowledge' })
    expect(r.get()).toMatchObject({ name: 'failed', survivors: ['indexeddb:wot-identity'] })
    expect(d.device.vault.stores.meta.get('resume')).toMatchObject({ flow: 'legacy-wipe' })
    await drive(r, { type: 'retry' })
    expect(r.get().name).toBe('failed')
    p = await d.restart()
    expect(p.runtime.state.get()).toEqual({ status: 'legacy-gen2', resume: true })
    d.device.faults.wipeSurvivor = null
    r = cover.track(createFlowRunner(legacyReset, legacyStart(true), p.exec.legacy, p.platform))
    await drive(r)
    expect(r.get().name).toBe('exit')
    expect(d.device.vault.stores.meta.get('resume')).toBeUndefined()
  })

  it('a keystore entry under the Gen-2 alias alone counts as an old install (native)', async () => {
    const d = testDevice()
    d.device.legacy.keystore = true
    const p = await d.restart()
    expect(p.runtime.state.get()).toEqual({ status: 'legacy-gen2', resume: false })
  })
})
