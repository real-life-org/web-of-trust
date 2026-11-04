// The phones' berths on the workbench stage (architecture §7.4), the Claude Design workbench's rules:
// fixed berths filled right, left, right, left; a cap on devices open at once that drops the one
// longest untouched and hands its place to the newcomer; a position given once and kept.
import { describe, expect, it } from 'vitest'
import { berthAt, berths, closeDevice, corridor, EMPTY, FULL_W, moveDevice, openDevice, screenH, setCap } from '../harness/workbench/berths'

const stage = { w: 1400, h: 700 }

describe('berths', () => {
  it('four fixed berths: right-top, left-top below the camera overlay, then a step inward and down on each flank', () => {
    const b = berths(stage)
    expect(b).toHaveLength(4)
    expect(b[0]).toEqual({ x: 1400 - FULL_W - 20, y: 20 })
    expect(b[1]).toEqual({ x: 24, y: 120 })
    expect(b[2]?.x).toBe((b[0]?.x ?? 0) - 92)
    expect(b[3]?.x).toBe(24 + 92)
  })

  it('a berth is clamped onto a short stage so the window stays fully on it', () => {
    const short = { w: 1400, h: 300 }
    const b = berthAt(short, 3)
    expect(b.y).toBeLessThanOrEqual(300 - (32 + screenH(short)) - 4)
  })
})

describe('opening devices', () => {
  it('the first opens on the right flank, the second on the left; both keep their berth', () => {
    let s = openDevice(EMPTY, 'jonas', stage)
    s = openDevice(s, 'noah', stage)
    expect(s.open).toEqual(['jonas', 'noah'])
    expect(s.berth).toEqual({ jonas: 0, noah: 1 })
    expect(s.pos.jonas).toEqual(berthAt(stage, 0))
    expect(s.pos.noah).toEqual(berthAt(stage, 1))
    expect(s.focus).toBe('noah')
  })

  it('past the cap of two, the one longest untouched closes and the newcomer takes its place', () => {
    let s = openDevice(EMPTY, 'jonas', stage)
    s = openDevice(s, 'noah', stage)
    s = moveDevice(s, 'jonas', { x: 500, y: 200 })
    // noah is focused: jonas is the victim, lea inherits jonas's dragged position and berth
    s = openDevice(s, 'lea', stage)
    expect(s.open).toEqual(['noah', 'lea'])
    expect(s.pos.lea).toEqual({ x: 500, y: 200 })
    expect(s.berth.lea).toBe(0)
    expect(s.pos.jonas).toBeUndefined()
  })

  it('the focused device is never the victim', () => {
    let s = openDevice(EMPTY, 'jonas', stage)
    s = openDevice(s, 'noah', stage)
    s = { ...s, focus: 'jonas' }
    s = openDevice(s, 'lea', stage)
    expect(s.open).toEqual(['jonas', 'lea'])
  })

  it('opening an open device raises it and pulls it back onto the stage', () => {
    let s = openDevice(EMPTY, 'jonas', stage)
    s = moveDevice(s, 'jonas', { x: -300, y: 2000 })
    s = openDevice(s, 'jonas', stage)
    expect(s.pos.jonas?.x).toBe(4)
    expect(s.pos.jonas?.y).toBeLessThan(700)
    expect(s.focus).toBe('jonas')
  })

  it('with a cap of four the berths fill in order; a fifth cascades', () => {
    let s = setCap(EMPTY, 4, stage)
    for (const id of ['a', 'b', 'c', 'd']) s = openDevice(s, id, stage)
    expect(Object.values(s.berth).sort()).toEqual([0, 1, 2, 3])
    s = setCap(s, 4, stage)
    s = { ...s, cap: 5 }
    s = openDevice(s, 'e', stage)
    expect(s.berth.e).toBeUndefined()
    expect(s.pos.e).toBeDefined()
  })

  it('closing frees the berth; the next device opens there again', () => {
    let s = openDevice(EMPTY, 'jonas', stage)
    s = openDevice(s, 'noah', stage)
    s = closeDevice(s, 'jonas')
    expect(s.open).toEqual(['noah'])
    expect(s.focus).toBe('noah')
    s = openDevice(s, 'lea', stage)
    expect(s.berth.lea).toBe(0)
  })
})

describe('the cap', () => {
  it('lowering it drops the devices longest untouched, keeps the focused one and re-seats the survivors', () => {
    let s = setCap(EMPTY, 4, stage)
    for (const id of ['a', 'b', 'c', 'd']) s = openDevice(s, id, stage)
    s = { ...s, focus: 'a' }
    s = moveDevice(s, 'a', { x: 600, y: 300 })
    s = setCap(s, 2, stage)
    expect(s.open).toEqual(['a', 'd'])
    expect(s.berth).toEqual({ a: 0, d: 1 })
    expect(s.pos.a).toEqual(berthAt(stage, 0))
    expect(s.cap).toBe(2)
  })

  it('is at least one and at most four', () => {
    expect(setCap(EMPTY, 0, stage).cap).toBe(1)
    expect(setCap(EMPTY, 9, stage).cap).toBe(4)
  })
})

describe('the corridor and the screen', () => {
  it('no device: the whole stage; one: the strip beside it; two: between the flanks', () => {
    expect(corridor(stage, 0)).toEqual({ w: 1400 - 32, cx: 700 })
    expect(corridor(stage, 1).cx).toBeLessThan(700)
    expect(corridor(stage, 2)).toEqual({ w: 1400 - 2 * (FULL_W + 20) - 24, cx: 700 })
  })

  it('a narrow stage with two devices keeps the whole width', () => {
    expect(corridor({ w: 800, h: 700 }, 2).w).toBe(800 - 32)
  })

  it('the screen is as tall as the stage allows, between 150 and 430', () => {
    expect(screenH({ w: 1400, h: 700 })).toBe(430)
    expect(screenH({ w: 1400, h: 400 })).toBe(400 - 20 - 8 - 32)
    expect(screenH({ w: 1400, h: 100 })).toBe(150)
  })
})
