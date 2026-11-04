// Where the phones sit on the stage (architecture §7.4), the rules of the Claude Design workbench:
//
// - A device gets its position exactly once, when it opens; positions of devices on the stage are
//   never recomputed (that recomputation made open windows jump). A drag moves it; nothing else does.
// - Fixed berths on the flanks of the graph, filled corner by corner so left and right stay even:
//   right-top, left-top, right-bottom, left-bottom. The left column starts below the camera overlay,
//   which owns the top left. A device holds its berth index as long as it is open, so dragging a
//   phone away from its berth does not free it. Past four berths the next window cascades.
// - A cap says how many devices are open at once (default 2: a ceremony needs two, and two phones
//   fit beside the graph). Opening past the cap drops the device longest untouched, never the
//   focused one; the newcomer inherits the victim's berth and position, so swapping who is shown
//   never moves the window. Lowering the cap drops by the same rule and re-seats the survivors.
// - The graph's centre leans away from an occupied flank: one device open, the graph takes the free
//   strip beside it; two or more, the strip between the flanks.
// - A phone's screen is as tall as the stage allows, between 150 and 430 px.

export const FULL_W = 280
export const CHROME_H = 32
export const WIN_TOP = 20
/** the left column starts below the camera overlay */
export const LEFT_TOP = 120
export const DEFAULT_CAP = 2
export const MAX_CAP = 4

export interface Pos {
  readonly x: number
  readonly y: number
}

export interface Layout {
  readonly open: readonly string[]
  readonly focus: string | null
  readonly berth: Readonly<Record<string, number>>
  readonly pos: Readonly<Record<string, Pos>>
  readonly collapsed: Readonly<Record<string, boolean>>
  readonly cap: number
}

export const EMPTY: Layout = { open: [], focus: null, berth: {}, pos: {}, collapsed: {}, cap: DEFAULT_CAP }

export interface Stage {
  readonly w: number
  readonly h: number
}

const clamp = (lo: number, v: number, hi: number) => Math.max(lo, Math.min(v, hi))

export function screenH(stage: Stage): number {
  return Math.round(clamp(150, stage.h - WIN_TOP - 8 - CHROME_H, 430))
}

export function winH(stage: Stage): number {
  return CHROME_H + screenH(stage)
}

/** the lowest top a window may open at: fully on the stage */
function gridMaxTop(stage: Stage): number {
  return Math.max(4, stage.h - winH(stage) - 4)
}

export function berths(stage: Stage): readonly Pos[] {
  const right = Math.round(stage.w - FULL_W - 20)
  const left = 24
  const step = { x: 92, y: 104 }
  const maxTop = Math.max(4, Math.round(stage.h - 30))
  return [
    { x: right, y: WIN_TOP },
    { x: left, y: LEFT_TOP },
    { x: right - step.x, y: Math.min(maxTop, WIN_TOP + step.y) },
    { x: left + step.x, y: Math.min(maxTop, LEFT_TOP + 88) },
  ]
}

export function berthAt(stage: Stage, i: number): Pos {
  const bs = berths(stage)
  const b = bs[i] ?? (bs[bs.length - 1] as Pos)
  return { x: Math.round(clamp(4, b.x, Math.max(4, stage.w - FULL_W - 4))), y: Math.round(clamp(4, b.y, gridMaxTop(stage))) }
}

function freeBerth(open: readonly string[], berth: Readonly<Record<string, number>>): number | null {
  const used = new Set(open.map((o) => berth[o]).filter((i): i is number => i !== undefined))
  for (let i = 0; i < 4; i++) if (!used.has(i)) return i
  return null
}

/** past the berths: a cascade down and left from the last window, every title bar keeps its right edge */
function freeSlot(stage: Stage, taken: readonly Pos[]): Pos {
  const last = taken[taken.length - 1] ?? { x: stage.w - FULL_W - 96, y: 4 }
  return { x: Math.max(Math.round(stage.w * 0.28), Math.round(last.x - 34)), y: clamp(4, last.y + 36, gridMaxTop(stage)) }
}

/** a device is opened, or raised and pulled fully into view when it is open already */
export function openDevice(s: Layout, id: string, stage: Stage): Layout {
  if (s.open.includes(id)) {
    const p = s.pos[id]
    const pulled = p ? { x: clamp(4, p.x, Math.max(4, stage.w - FULL_W - 4)), y: clamp(4, p.y, gridMaxTop(stage)) } : null
    return { ...s, focus: id, collapsed: { ...s.collapsed, [id]: false }, pos: pulled ? { ...s.pos, [id]: pulled } : s.pos }
  }
  let open = s.open
  const pos: Record<string, Pos> = { ...s.pos }
  const berth: Record<string, number> = { ...s.berth }
  let inherited: Pos | null = null
  let inheritedBerth: number | null = null
  if (open.length >= s.cap) {
    const drop = open.filter((o) => o !== s.focus).slice(0, open.length - s.cap + 1)
    const victims = drop.length ? drop : open.slice(0, open.length - s.cap + 1)
    const last = victims[victims.length - 1] as string
    inherited = pos[last] ?? null
    inheritedBerth = berth[last] ?? null
    open = open.filter((o) => !victims.includes(o))
    for (const o of victims) {
      delete pos[o]
      delete berth[o]
    }
  }
  const idx = inheritedBerth ?? freeBerth(open, berth)
  if (idx !== null) berth[id] = idx
  const at = inherited ?? (idx !== null ? berthAt(stage, idx) : freeSlot(stage, open.map((o) => pos[o]).filter((p): p is Pos => p !== undefined)))
  return { ...s, open: [...open, id], focus: id, collapsed: { ...s.collapsed, [id]: false }, berth, pos: { ...pos, [id]: at } }
}

export function closeDevice(s: Layout, id: string): Layout {
  const open = s.open.filter((o) => o !== id)
  const berth = { ...s.berth }
  delete berth[id]
  const pos = { ...s.pos }
  delete pos[id]
  return { ...s, open, berth, pos, focus: s.focus === id ? (open[open.length - 1] ?? null) : s.focus }
}

export function moveDevice(s: Layout, id: string, to: Pos): Layout {
  return { ...s, pos: { ...s.pos, [id]: to } }
}

export function collapseDevice(s: Layout, id: string, collapsed: boolean): Layout {
  return { ...s, collapsed: { ...s.collapsed, [id]: collapsed }, ...(collapsed ? {} : { focus: id }) }
}

export function focusDevice(s: Layout, id: string): Layout {
  return s.open.includes(id) ? { ...s, focus: id, collapsed: { ...s.collapsed, [id]: false } } : s
}

/** lowering the cap drops the devices longest untouched, keeping the focused one, and re-seats the survivors */
export function setCap(s: Layout, n: number, stage: Stage): Layout {
  const cap = clamp(1, Math.round(n), MAX_CAP)
  let open = s.open
  if (open.length > cap) {
    const keep = new Set<string>(s.focus !== null && open.includes(s.focus) ? [s.focus] : [])
    for (let i = open.length - 1; i >= 0 && keep.size < cap; i--) keep.add(open[i] as string)
    open = open.filter((o) => keep.has(o))
  }
  const berth: Record<string, number> = {}
  const pos: Record<string, Pos> = {}
  open.forEach((o, i) => {
    berth[o] = i
    pos[o] = berthAt(stage, i)
  })
  return { ...s, cap, open, berth, pos, focus: s.focus !== null && open.includes(s.focus) ? s.focus : (open[open.length - 1] ?? null) }
}

export function capNote(cap: number): string {
  return cap === 1
    ? 'One device. A ceremony needs a second: open one and this one closes.'
    : cap === 2
      ? 'Two berths, one on each flank. What a ceremony needs, and what fits beside the graph.'
      : 'Devices alternate right and left; a second one on the same flank overlaps the first.'
}

/** the graph's corridor: its width and centre, leaning away from the occupied flanks */
export function corridor(stage: Stage, openCount: number): { readonly w: number; readonly cx: number } {
  const W = stage.w
  if (openCount === 1) {
    const w = Math.max(360, W - FULL_W - 36)
    return { w, cx: Math.round(w / 2) + 12 }
  }
  if (openCount >= 2) {
    const inner = W - 2 * (FULL_W + 20) - 24
    if (inner >= 300) return { w: inner, cx: Math.round(W / 2) }
  }
  return { w: W - 32, cx: Math.round(W / 2) }
}
