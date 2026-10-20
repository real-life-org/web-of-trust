// Fake platform for Vitest and the harness (architecture §5): virtual clock, deterministic
// entropy, fixed language, in-memory prefs. Never part of a store build (scripts/check-build.mjs).

import type { ClockPort, EntropyPort, Language, LanguagePort, Platform, PrefsPort, ScannerPort } from '../ports'
import { fakeClipboard, fakeDevice, fakeDevicePrefs, fakeScreen, type FakeDevice, type FakeScreen } from './identity'

export * from './identity'

export interface VirtualClock extends ClockPort {
  advance(ms: number): void
  set(at: number): void
}

/** A clock that only moves when told to. Timers fire in order during advance()/set(). */
export function virtualClock(start: number, timeZone: string): VirtualClock {
  let now = start
  let seq = 0
  const timers = new Map<number, { at: number; cb: () => void }>()
  const runDue = (): void => {
    for (;;) {
      let next: [number, { at: number; cb: () => void }] | null = null
      for (const entry of timers) if (entry[1].at <= now && (next === null || entry[1].at < next[1].at)) next = entry
      if (next === null) return
      timers.delete(next[0])
      next[1].cb()
    }
  }
  return {
    now: () => now,
    timeZone: () => timeZone,
    setTimer(at, cb) {
      const id = ++seq
      timers.set(id, { at, cb })
      return () => timers.delete(id)
    },
    advance(ms) {
      now += ms
      runDue()
    },
    set(at) {
      now = Math.max(now, at)
      runDue()
    },
  }
}

/** Deterministic: uuid() and bytes() follow a seeded xorshift sequence. */
export function fakeEntropy(seed = 0x2f6b9a1d): EntropyPort {
  let s = seed >>> 0 || 1
  const next = (): number => {
    s ^= s << 13
    s >>>= 0
    s ^= s >>> 17
    s ^= s << 5
    s >>>= 0
    return s
  }
  const bytes = (n: number): Uint8Array => {
    const out = new Uint8Array(n)
    for (let i = 0; i < n; i++) out[i] = next() & 0xff
    return out
  }
  return {
    bytes,
    uuid() {
      const b = bytes(16)
      b[6] = ((b[6] ?? 0) & 0x0f) | 0x40
      b[8] = ((b[8] ?? 0) & 0x3f) | 0x80
      const h = [...b].map((x) => x.toString(16).padStart(2, '0')).join('')
      return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`
    },
  }
}

export function fakePrefs(): PrefsPort {
  return fakeDevicePrefs(fakeDevice())
}

export function fakeLanguage(initial: Language): LanguagePort {
  let current = initial
  const listeners = new Set<() => void>()
  return {
    system: () => [initial],
    current: () => current,
    inAppChoice: true,
    set(lang) {
      if (lang === current) return
      current = lang
      for (const l of [...listeners]) l()
    },
    openSystemSettings: async () => false,
    subscribe(cb) {
      listeners.add(cb)
      return () => listeners.delete(cb)
    },
  }
}

/** The camera as a test double: what it "sees" comes from `source` (the harness points it at the QR
 *  another phone shows); `camera` switches availability and permission (FaultSwitches.camera). */
export interface FakeScanner extends ScannerPort {
  /** revoked: permission granted at the check, withdrawn at the scan; broken: the camera fails */
  camera: 'ok' | 'prompt' | 'denied' | 'unavailable' | 'revoked' | 'broken'
  /** the text in front of the camera, or null; polled until something appears or the scan is aborted */
  source: () => string | null
  readonly settingsOpened: number
}

export function fakeScanner(): FakeScanner {
  let settings = 0
  const s: FakeScanner = {
    camera: 'ok',
    source: () => null,
    get settingsOpened() {
      return settings
    },
    availability: async () => (s.camera === 'unavailable' ? 'no-camera' : 'available'),
    permission: async () => (s.camera === 'prompt' ? 'prompt' : s.camera === 'denied' ? 'denied' : 'granted'),
    async scan({ signal }) {
      if (s.camera === 'denied' || s.camera === 'revoked') return { kind: 'permission-denied' }
      if (s.camera === 'unavailable' || s.camera === 'broken') return { kind: 'error', message: 'camera failed' }
      for (;;) {
        if (signal.aborted) return { kind: 'cancelled' }
        const text = s.source()
        if (text) return { kind: 'ok', text }
        await new Promise((r) => setTimeout(r, 100))
      }
    },
    async openSettings() {
      settings++
    },
  }
  return s
}

export function createFakePlatform(opts: {
  clock: VirtualClock
  language?: Language
  seed?: number
  /** the simulated device whose prefs and clipboard the platform uses (identity flows) */
  device?: FakeDevice
  scanner?: FakeScanner
}): Platform & { scanner: FakeScanner; screen: FakeScreen } {
  const device = opts.device ?? fakeDevice()
  return {
    clock: opts.clock,
    entropy: fakeEntropy(opts.seed),
    language: fakeLanguage(opts.language ?? 'en'),
    prefs: fakeDevicePrefs(device),
    clipboard: fakeClipboard(device),
    screen: fakeScreen(),
    scanner: opts.scanner ?? fakeScanner(),
  }
}
