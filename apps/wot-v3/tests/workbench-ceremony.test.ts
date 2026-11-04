// The ceremony on the workbench (architecture §7.4): a phone's camera sees the code another phone
// shows only through the lens, which the page opens once the scanning phone has flown over the code.
// The world says who scans and whose code it is; the scan waits for the lens and ends the state.
import { describe, expect, it } from 'vitest'
import { createWorkbenchWorld, PEOPLE } from '../harness/workbench/world'

const world = () => createWorkbenchWorld({ people: PEOPLE.slice(0, 3), carrier: { kind: 'memory' }, lang: 'en', theme: 'light', met: [] })
const tick = () => new Promise((r) => setTimeout(r, 150))

describe('the ceremony state', () => {
  it('Noah shows, Jonas opens the camera: the world names both; the code reaches the camera only after land()', async () => {
    const w = await world()
    const noah = w.devices.get('noah'), jonas = w.devices.get('jonas')
    if (!noah || !jonas) throw new Error('phones')
    const shown = await noah.port.trust.showCard().done
    expect(shown.ok).toBe(true)
    expect(w.ceremony.get()).toEqual({ scanning: null, showing: null, lens: false })
    const ctl = new AbortController()
    let result: unknown = null
    const scan = jonas.platform.scanner.scan({ target: null, signal: ctl.signal }).then((r) => (result = r))
    await tick()
    expect(w.ceremony.get()).toEqual({ scanning: 'jonas', showing: 'noah', lens: false })
    expect(result).toBeNull()
    w.ceremony.land()
    expect(w.ceremony.get().lens).toBe(true)
    await scan
    expect(result).toMatchObject({ kind: 'ok', text: shown.ok ? shown.value.qr : '' })
    expect(w.ceremony.get()).toEqual({ scanning: null, showing: null, lens: false })
  }, 30_000)

  it('nobody shows a code: the camera is open with nothing to point at; a cancel ends it', async () => {
    const w = await world()
    const jonas = w.devices.get('jonas')
    if (!jonas) throw new Error('phones')
    const ctl = new AbortController()
    const scan = jonas.platform.scanner.scan({ target: null, signal: ctl.signal })
    await tick()
    expect(w.ceremony.get()).toEqual({ scanning: 'jonas', showing: null, lens: false })
    w.ceremony.land()
    await tick()
    expect(w.ceremony.get()).toMatchObject({ scanning: 'jonas', lens: true })
    ctl.abort()
    expect(await scan).toEqual({ kind: 'cancelled' })
    expect(w.ceremony.get()).toEqual({ scanning: null, showing: null, lens: false })
  }, 30_000)

  it('land() without a scan changes nothing', async () => {
    const w = await world()
    w.ceremony.land()
    expect(w.ceremony.get()).toEqual({ scanning: null, showing: null, lens: false })
  }, 30_000)
})
