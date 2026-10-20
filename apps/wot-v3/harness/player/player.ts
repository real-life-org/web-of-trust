// The scenario player's model (architecture §7.3), without React and without a browser: which
// scenario, how many phones, the player time, the fault switches, the timeline cursor with
// play/pause/step, language and theme. Phones attach a controller (phone.ts) from their iframe;
// the player drives them only through it, with plain data, because each phone lives in its own
// realm (an own React, an own Secret WeakMap).

import type { WorldAction } from '../../src/adapters/sim'
import { NO_FAULTS, type PhoneSpec, type PlayerFaults, type Scenario, type Step } from '../scenario'
import { describeStep, parseOffset } from './timeline'
import { createSimTransport, type Delivery } from './transport'

export type PlayerLang = 'en' | 'de'
export type PlayerTheme = 'light' | 'dark' | 'system'

/** What a phone offers the player. Arguments and results are plain data. */
export interface PhoneController {
  readonly index: number
  now(): number
  advance(ms: number): void
  /** the device clock set back (no timer runs) */
  rewind(ms: number): void
  /** on attach: the player time and the shared high-water mark (a set-back clock stays set back) */
  sync(at: number, highWater: number): void
  /** the player's fault switches and the number of this phone's deliveries waiting in the transport */
  setFaults(faults: PlayerFaults, queued: number): void
  apply(action: WorldAction): void
  setLang(lang: PlayerLang): void
  setTheme(theme: PlayerTheme): void
  /** redacted state for the inspector: no words, passphrases or keys */
  inspect(): Readonly<Record<string, unknown>>
}

/** The registry a phone iframe finds on window.parent. */
export interface PlayerHost {
  attach(controller: PhoneController): void
  detach(controller: PhoneController): void
}

export interface PlayerState {
  readonly scenarioId: string
  /** bumped on every scenario or catalog change: the phones reload */
  readonly epoch: number
  readonly phoneCount: number
  readonly catalog: string | null
  readonly lang: PlayerLang
  readonly theme: PlayerTheme
  readonly faults: PlayerFaults
  /** player time; null until the first phone attached */
  readonly now: number | null
  /** the latest player time so far; now below it = the clock was set back */
  readonly highWater: number | null
  readonly cursor: number
  readonly playing: boolean
  readonly attached: readonly number[]
  /** every shown phone is attached: only then do steps run (a step before would lose its offset,
   *  its echo or its world action) */
  readonly ready: boolean
  readonly transport: { readonly state: 'up' | 'down'; readonly queued: number; readonly delivered: number }
  readonly log: readonly string[]
}

export interface Player extends PlayerHost {
  get(): PlayerState
  subscribe(cb: () => void): () => void
  scenario(): Scenario
  timeline(): readonly Step[]
  /** the specs of the phones shown now */
  phones(): readonly PhoneSpec[]
  select(id: string): void
  setPhoneCount(n: number): void
  setCatalog(id: string | null): void
  setLang(lang: PlayerLang): void
  setTheme(theme: PlayerTheme): void
  setFault(f: Partial<PlayerFaults>): void
  advanceClock(ms: number): void
  rewindClock(ms: number): void
  jumpTo(at: number): void
  step(): void
  play(): void
  pause(): void
  /** the scenario again from its start */
  reset(): void
  /** the redacted state of every attached phone, in phone order (inspector) */
  inspect(): readonly Readonly<Record<string, unknown>>[]
}

export const MAX_PHONES = 3
const LOG_LINES = 40

export function createPlayer(scenarios: Readonly<Record<string, Scenario>>, opts: { stepMs?: number; initial?: string } = {}): Player {
  const stepMs = opts.stepMs ?? 1_200
  const ids = Object.keys(scenarios)
  const first = opts.initial && scenarios[opts.initial] ? opts.initial : (ids[0] ?? '')
  const controllers = new Map<number, PhoneController>()
  let timer: ReturnType<typeof setInterval> | null = null
  const listeners = new Set<() => void>()

  const scenarioOf = (id: string): Scenario => {
    const s = scenarios[id]
    if (!s) throw new Error(`player: unknown scenario ${id}`)
    return s
  }
  const defaultCount = (s: Scenario) => Math.min(MAX_PHONES, Math.max(1, Math.min(2, s.phones?.length ?? 1)))

  let state: PlayerState = {
    scenarioId: first,
    epoch: 1,
    phoneCount: first ? defaultCount(scenarioOf(first)) : 1,
    catalog: null,
    lang: 'en',
    theme: 'system',
    faults: NO_FAULTS,
    now: null,
    highWater: null,
    cursor: 0,
    playing: false,
    attached: [],
    ready: false,
    transport: { state: 'up', queued: 0, delivered: 0 },
    log: [],
  }

  const emit = () => {
    for (const l of [...listeners]) l()
  }
  const set = (patch: Partial<PlayerState>) => {
    state = { ...state, ...patch }
    emit()
  }
  const log = (line: string) => {
    state = { ...state, log: [...state.log, line].slice(-LOG_LINES) }
  }

  const specs = (): readonly PhoneSpec[] => {
    const s = scenarioOf(state.scenarioId)
    const own = s.phones ?? []
    return Array.from({ length: state.phoneCount }, (_, i) => own[i] ?? { label: `Device ${i + 1}`, scenario: s.id, person: `device-${i + 1}` })
  }
  const specOf = (i: number): PhoneSpec | undefined => (scenarioOf(state.scenarioId).phones ?? [])[i]

  const queuedFrom = (i: number) => transport.get().queued.filter((d) => d.from === i).length
  const pushFaults = () => {
    for (const [i, c] of controllers) c.setFaults(state.faults, queuedFrom(i))
  }

  const makeTransport = () => {
    const t = createSimTransport((d: Delivery) => {
      const c = controllers.get(d.to)
      const from = specOf(d.from)
      if (!c || !from) return false
      c.apply({ type: 'receive', key: `c:${from.person}`, from: from.person, text: d.text })
      return true
    })
    t.subscribe(() => {
      const v = t.get()
      state = { ...state, transport: { state: v.state, queued: v.queued.length, delivered: v.delivered } }
      pushFaults()
    })
    return t
  }
  let transport = makeTransport()

  const stopTimer = () => {
    if (timer !== null) clearInterval(timer)
    timer = null
  }

  const moveClocks = (ms: number) => {
    if (state.now === null || ms === 0) return
    for (const c of controllers.values()) {
      if (ms > 0) c.advance(ms)
      else c.rewind(-ms)
    }
    const now = state.now + ms
    state = { ...state, now, highWater: Math.max(state.highWater ?? now, now) }
  }

  const setFaults = (f: Partial<PlayerFaults>) => {
    state = { ...state, faults: { ...state.faults, ...f } }
    if (f.transport) transport.setState(f.transport)
    pushFaults()
  }

  const run = (step: Step) => {
    moveClocks(parseOffset(step.at))
    log(`▶ ${describeStep(step)}`)
    if ('fault' in step) {
      setFaults(step.fault)
    } else if ('send' in step) {
      const { from, to, text } = step.send
      const sender = controllers.get(from)
      const target = specOf(to)
      if (sender && target) sender.apply({ type: 'receive', key: `c:${target.person}`, from: 'me', text })
      transport.send(from, to, text, state.now ?? 0)
      if (!sender) log(`  phone ${from + 1} not shown: no echo on the sender`)
    } else {
      const i = step.phone ?? 0
      const c = controllers.get(i)
      if (c) c.apply(step.world)
      else log(`  phone ${i + 1} not shown: skipped`)
    }
  }

  const membership = (phoneCount: number) => {
    const attached = [...controllers.keys()].sort((a, b) => a - b)
    return { attached, ready: attached.length === phoneCount && attached.every((i, n) => i === n) }
  }

  const step = () => {
    if (!state.ready) return
    const tl = scenarioOf(state.scenarioId).timeline ?? []
    const next = tl[state.cursor]
    if (!next) {
      stopTimer()
      set({ playing: false })
      return
    }
    run(next)
    const cursor = state.cursor + 1
    const done = cursor >= tl.length
    if (done) stopTimer()
    set({ cursor, playing: done ? false : state.playing })
  }

  const restart = (scenarioId: string, phoneCount: number, catalog: string | null) => {
    stopTimer()
    controllers.clear()
    transport = makeTransport()
    set({
      transport: { state: 'up', queued: 0, delivered: 0 },
      scenarioId,
      phoneCount,
      catalog,
      epoch: state.epoch + 1,
      faults: NO_FAULTS,
      now: null,
      highWater: null,
      cursor: 0,
      playing: false,
      attached: [],
      ready: false,
      log: [],
    })
  }

  return {
    get: () => state,
    subscribe(cb) {
      listeners.add(cb)
      return () => listeners.delete(cb)
    },
    scenario: () => scenarioOf(state.scenarioId),
    timeline: () => scenarioOf(state.scenarioId).timeline ?? [],
    phones: specs,
    select(id) {
      restart(id, defaultCount(scenarioOf(id)), null)
    },
    setPhoneCount(n) {
      const phoneCount = Math.min(MAX_PHONES, Math.max(1, Math.round(n)))
      if (phoneCount === state.phoneCount) return
      for (const i of [...controllers.keys()]) if (i >= phoneCount) controllers.delete(i)
      set({ phoneCount, ...membership(phoneCount) })
    },
    setCatalog(id) {
      restart(state.scenarioId, state.phoneCount, id)
    },
    setLang(lang) {
      for (const c of controllers.values()) c.setLang(lang)
      set({ lang })
    },
    setTheme(theme) {
      for (const c of controllers.values()) c.setTheme(theme)
      set({ theme })
    },
    setFault(f) {
      setFaults(f)
      emit()
    },
    advanceClock(ms) {
      moveClocks(Math.abs(ms))
      emit()
    },
    rewindClock(ms) {
      moveClocks(-Math.abs(ms))
      emit()
    },
    jumpTo(at) {
      if (state.now === null) return
      moveClocks(at - state.now)
      emit()
    },
    step,
    play() {
      if (state.playing) return
      if (state.cursor >= (scenarioOf(state.scenarioId).timeline ?? []).length) return
      timer = setInterval(step, stepMs)
      set({ playing: true })
    },
    pause() {
      stopTimer()
      set({ playing: false })
    },
    reset() {
      restart(state.scenarioId, state.phoneCount, state.catalog)
    },
    inspect: () => [...controllers.entries()].sort(([a], [b]) => a - b).map(([, c]) => c.inspect()),
    attach(c) {
      if (c.index >= state.phoneCount) return
      controllers.set(c.index, c)
      if (state.now === null) state = { ...state, now: c.now(), highWater: c.now() }
      c.sync(state.now ?? c.now(), state.highWater ?? c.now())
      c.setLang(state.lang)
      c.setTheme(state.theme)
      c.setFaults(state.faults, queuedFrom(c.index))
      state = { ...state, ...membership(state.phoneCount) }
      transport.flush()
      emit()
    },
    detach(c) {
      if (controllers.get(c.index) !== c) return
      controllers.delete(c.index)
      set(membership(state.phoneCount))
    },
  }
}
