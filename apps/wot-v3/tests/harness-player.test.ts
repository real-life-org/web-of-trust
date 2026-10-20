// Scenario player (architecture §7.3): timeline, shared transport, player orchestration and the
// phone controller with its fault switches. The React view and the iframes are covered by
// e2e/player.spec.ts; here everything runs without a browser.
import { describe, expect, it, vi } from 'vitest'
import { virtualClock } from '../src/platform/fake'
import { secret, type Mnemonic, type Secret } from '../src/port'
import { parseOffset, describeStep, zonedWallTime } from '../harness/player/timeline'
import { createSimTransport } from '../harness/player/transport'
import { createPlayer, type PhoneController } from '../harness/player/player'
import { createPhone } from '../harness/player/phone'
import { PLAYER_SCENARIOS } from '../harness/player/scenarios'
import { NO_FAULTS, type PlayerFaults } from '../harness/scenario'
import { HARNESS_PASSPHRASE } from '../harness/boot'
import { TEST_PHRASE } from '../harness/catalog'

const flush = () => new Promise((r) => setTimeout(r, 0))

describe('virtual clock set back (platform/fake)', () => {
  it('rewind moves now back without running timers; they fire once the clock passes them again', () => {
    const clock = virtualClock(10_000, 'UTC')
    const fired: number[] = []
    clock.setTimer(12_000, () => fired.push(clock.now()))
    clock.rewind(5_000)
    expect(clock.now()).toBe(5_000)
    expect(fired).toEqual([])
    clock.advance(6_000)
    expect(fired).toEqual([])
    clock.advance(1_000)
    expect(fired).toEqual([12_000])
  })
})

describe('timeline', () => {
  it('parses offsets in virtual time', () => {
    expect(parseOffset('+0s')).toBe(0)
    expect(parseOffset('+2s')).toBe(2_000)
    expect(parseOffset('+5m')).toBe(300_000)
    expect(parseOffset('+1h')).toBe(3_600_000)
    expect(parseOffset('+1d')).toBe(86_400_000)
    expect(() => parseOffset('2s')).toThrow(/offset/)
    expect(() => parseOffset('+2w')).toThrow(/offset/)
  })

  it('reads a wall time in the scenario time zone on the target date (DST aware)', () => {
    const la = 'America/Los_Angeles'
    expect(new Date(zonedWallTime('2026-10-17T09:00', la)).toISOString()).toBe('2026-10-17T16:00:00.000Z')
    expect(new Date(zonedWallTime('2026-11-02T09:00', la)).toISOString()).toBe('2026-11-02T17:00:00.000Z')
    expect(new Date(zonedWallTime('2026-10-15T13:30', 'Europe/Berlin')).toISOString()).toBe('2026-10-15T11:30:00.000Z')
    expect(Number.isNaN(zonedWallTime('nonsense', la))).toBe(true)
  })

  it('describes steps for the step list, note first', () => {
    expect(describeStep({ at: '+2s', send: { from: 1, to: 0, text: 'Hi' } })).toBe('phone 2 → phone 1: “Hi”')
    expect(describeStep({ at: '+1m', fault: { transport: 'down' } })).toBe('fault: transport down')
    expect(describeStep({ at: '+1m', world: { type: 'receive', key: 'c:priya', from: 'priya', text: 'Yo' } })).toBe('phone 1: receive c:priya')
    expect(describeStep({ at: '+1m', note: 'Priya asks', send: { from: 1, to: 0, text: 'Hi' } })).toBe('Priya asks')
  })
})

describe('shared sim transport', () => {
  it('delivers at once while up, queues while down and flushes in order when up again', () => {
    const delivered: string[] = []
    const t = createSimTransport((d) => {
      delivered.push(`${d.from}>${d.to}:${d.text}`)
      return true
    })
    t.send(0, 1, 'a', 1)
    expect(delivered).toEqual(['0>1:a'])
    t.setState('down')
    t.send(0, 1, 'b', 2)
    t.send(1, 0, 'c', 3)
    expect(delivered).toEqual(['0>1:a'])
    expect(t.get()).toMatchObject({ state: 'down', queued: [{ text: 'b' }, { text: 'c' }] })
    t.setState('up')
    expect(delivered).toEqual(['0>1:a', '0>1:b', '1>0:c'])
    expect(t.get().queued).toEqual([])
  })

  it('keeps a delivery queued when its phone is not attached', () => {
    let attached = false
    const t = createSimTransport(() => attached)
    t.send(0, 2, 'x', 1)
    expect(t.get().queued).toHaveLength(1)
    attached = true
    t.flush()
    expect(t.get().queued).toHaveLength(0)
  })
})

/** A controller double that records what the player does to it. */
function stubPhone(index: number, start = 1_000_000) {
  let now = start
  const calls: string[] = []
  const c: PhoneController = {
    index,
    now: () => now,
    advance: (ms) => {
      now += ms
      calls.push(`advance:${ms}`)
    },
    rewind: (ms) => {
      now -= ms
      calls.push(`rewind:${ms}`)
    },
    sync: (at, highWater) => {
      calls.push(`sync:${at}:${highWater}`)
      now = at
    },
    setFaults: (f: PlayerFaults, queued: number) => calls.push(`faults:${f.transport}/${f.vault}/${f.biometric}/${f.hostClose}/q${queued}`),
    apply: (a) => calls.push(`apply:${a.type}:${'key' in a ? a.key : ''}:${'from' in a ? a.from : ''}:${'text' in a ? a.text : ''}`),
    setLang: (l) => calls.push(`lang:${l}`),
    setTheme: (t) => calls.push(`theme:${t}`),
    inspect: () => ({ index }),
  }
  return { c, calls }
}

describe('player', () => {
  it('offers every harness scenario and the player scenarios', () => {
    const ids = Object.keys(PLAYER_SCENARIOS)
    for (const id of ['iiw', 'empty', 'locked', 'fresh-install', 'iiw-duo', 'iiw-priya', 'iiw-marcus']) expect(ids).toContain(id)
  })

  it('a duo scenario names its phones; a plain one shows copies of itself', () => {
    const p = createPlayer(PLAYER_SCENARIOS)
    p.select('iiw-duo')
    expect(p.get().phoneCount).toBe(2)
    p.setPhoneCount(3)
    expect(p.phones().map((s) => [s.label, s.scenario])).toEqual([
      ['Jonas', 'iiw'],
      ['Priya', 'iiw-priya'],
      ['Marcus', 'iiw-marcus'],
    ])
    p.select('locked')
    expect(p.get().phoneCount).toBe(1)
    p.setPhoneCount(3)
    expect(p.phones().map((s) => s.scenario)).toEqual(['locked', 'locked', 'locked'])
    p.setPhoneCount(5)
    expect(p.get().phoneCount).toBe(3)
  })

  it('selecting a scenario starts a new epoch and resets the cursor, faults and clock', () => {
    const p = createPlayer(PLAYER_SCENARIOS)
    p.select('iiw-duo')
    const e = p.get().epoch
    p.setFault({ transport: 'down' })
    p.select('iiw')
    expect(p.get()).toMatchObject({ epoch: e + 1, cursor: 0, faults: NO_FAULTS, now: null, scenarioId: 'iiw' })
  })

  it('attaching syncs the phone to the player time, the faults and the view', () => {
    const p = createPlayer(PLAYER_SCENARIOS)
    p.select('iiw-duo')
    const a = stubPhone(0)
    p.attach(a.c)
    expect(p.get().now).toBe(1_000_000)
    p.advanceClock(60_000)
    p.setFault({ vault: 'fails' })
    p.setLang('de')
    const b = stubPhone(1)
    p.attach(b.c)
    expect(b.c.now()).toBe(1_060_000)
    expect(b.calls).toContain('sync:1060000:1060000')
    expect(b.calls).toContain('faults:up/fails/ok/ok/q0')
    expect(b.calls).toContain('lang:de')
    expect(p.get().attached).toEqual([0, 1])
    expect(p.inspect()).toEqual([{ index: 0 }, { index: 1 }])
    p.detach(b.c)
    expect(p.get().attached).toEqual([0])
  })

  it('clock: forward, back and jump move every phone together', () => {
    const p = createPlayer(PLAYER_SCENARIOS)
    p.select('iiw-duo')
    const a = stubPhone(0)
    const b = stubPhone(1)
    p.attach(a.c)
    p.attach(b.c)
    p.advanceClock(3_600_000)
    p.rewindClock(60_000)
    expect([a.c.now(), b.c.now(), p.get().now]).toEqual([4_540_000, 4_540_000, 4_540_000])
    expect(p.get().highWater).toBe(4_600_000)
    p.jumpTo(1_000_000)
    expect([a.c.now(), b.c.now()]).toEqual([1_000_000, 1_000_000])
    p.jumpTo(2_000_000)
    expect(a.calls.at(-1)).toBe('advance:1000000')
  })

  it('steps: advance by the offset, then act; a send goes over the transport and echoes on the sender', () => {
    const p = createPlayer(PLAYER_SCENARIOS)
    p.select('iiw-duo')
    const a = stubPhone(0)
    const b = stubPhone(1)
    p.attach(a.c)
    p.attach(b.c)
    const steps = PLAYER_SCENARIOS['iiw-duo']?.timeline ?? []
    expect(steps.length).toBeGreaterThanOrEqual(4)
    p.step() // Priya → Jonas
    expect(p.get().cursor).toBe(1)
    expect(b.calls).toContain('apply:receive:c:jonas:me:Are you at the Key Recovery session?')
    expect(a.calls).toContain('apply:receive:c:priya:priya:Are you at the Key Recovery session?')
    expect(a.calls).toContain('advance:10000')
  })

  it('transport down queues a step message until it is up; phones see the fault and their queue', () => {
    const p = createPlayer(PLAYER_SCENARIOS)
    p.select('iiw-duo')
    const a = stubPhone(0)
    const b = stubPhone(1)
    p.attach(a.c)
    p.attach(b.c)
    p.setFault({ transport: 'down' })
    expect(a.calls.at(-1)).toBe('faults:down/ok/ok/ok/q0')
    p.step() // Priya → Jonas, queued
    expect(a.calls.some((c) => c.startsWith('apply:receive:c:priya'))).toBe(false)
    expect(b.calls).toContain('faults:down/ok/ok/ok/q1')
    expect(p.get().transport).toMatchObject({ state: 'down', queued: 1 })
    p.setFault({ transport: 'up' })
    expect(a.calls).toContain('apply:receive:c:priya:priya:Are you at the Key Recovery session?')
    expect(p.get().transport.queued).toBe(0)
  })

  it('play runs the steps on a timer until the end; pause stops it', () => {
    vi.useFakeTimers()
    try {
      const p = createPlayer(PLAYER_SCENARIOS, { stepMs: 100 })
      p.select('iiw-duo')
      p.attach(stubPhone(0).c)
      p.attach(stubPhone(1).c)
      const total = PLAYER_SCENARIOS['iiw-duo']?.timeline?.length ?? 0
      p.play()
      expect(p.get().playing).toBe(true)
      vi.advanceTimersByTime(100)
      expect(p.get().cursor).toBe(1)
      p.pause()
      vi.advanceTimersByTime(1_000)
      expect(p.get().cursor).toBe(1)
      p.play()
      vi.advanceTimersByTime(100 * total)
      expect(p.get()).toMatchObject({ cursor: total, playing: false })
      p.step()
      expect(p.get().cursor).toBe(total)
    } finally {
      vi.useRealTimers()
    }
  })

  it('steps wait until every shown phone is attached (no lost offset, echo or action)', () => {
    vi.useFakeTimers()
    try {
      const p = createPlayer(PLAYER_SCENARIOS, { stepMs: 100 })
      p.select('iiw-duo')
      expect(p.get().ready).toBe(false)
      p.step()
      expect(p.get().cursor).toBe(0)
      const a = stubPhone(0)
      p.attach(a.c)
      p.play()
      vi.advanceTimersByTime(300)
      expect(p.get().cursor).toBe(0)
      expect(a.calls.some((c) => c.startsWith('apply:'))).toBe(false)
      const b = stubPhone(1)
      p.attach(b.c)
      expect(p.get().ready).toBe(true)
      vi.advanceTimersByTime(100)
      expect(p.get().cursor).toBe(1)
      expect(b.calls).toContain('apply:receive:c:jonas:me:Are you at the Key Recovery session?')
      expect(p.get().now).toBe(1_010_000)
      p.pause()
    } finally {
      vi.useRealTimers()
    }
  })

  it('a step for a phone that is not shown is logged as skipped', () => {
    const p = createPlayer(PLAYER_SCENARIOS)
    p.select('iiw-duo')
    p.setPhoneCount(1)
    p.attach(stubPhone(0).c)
    p.step() // Priya (phone 2) → Jonas: sender not attached, delivery still reaches Jonas
    expect(p.get().log.at(-1)).toMatch(/phone 2 not shown/)
  })

  it('notifies subscribers on every change', () => {
    const p = createPlayer(PLAYER_SCENARIOS)
    const seen: number[] = []
    p.subscribe(() => seen.push(p.get().epoch))
    p.select('iiw')
    p.setTheme('dark')
    expect(seen.length).toBe(2)
    expect(p.get().theme).toBe('dark')
  })
})

describe('phone controller (one app instance on the fake device)', () => {
  it('transport fault and clock set back show in the connectivity store', async () => {
    const { composition, controller } = await createPhone(PLAYER_SCENARIOS.iiw!, { index: 0 })
    const conn = composition.port.stores.connectivity
    expect(conn.get()).toMatchObject({ network: 'online', carrier: 'connected', queued: 0, clock: 'ok' })
    controller.setFaults({ ...NO_FAULTS, transport: 'down' }, 2)
    expect(conn.get()).toMatchObject({ carrier: 'unreachable', queued: 2 })
    controller.advance(60_000)
    controller.rewind(120_000)
    expect(conn.get().clock).toBe('behind')
    controller.advance(119_999)
    expect(conn.get().clock).toBe('behind')
    controller.advance(1)
    expect(conn.get().clock).toBe('ok')
  })

  it('a phone attached after a set-back clock reports it behind like the others', async () => {
    const p = createPlayer(PLAYER_SCENARIOS)
    p.select('iiw-duo')
    const a = await createPhone(PLAYER_SCENARIOS.iiw!, { index: 0 })
    const b = await createPhone(PLAYER_SCENARIOS['iiw-priya']!, { index: 1 })
    p.attach(a.controller)
    p.attach(b.controller)
    p.advanceClock(3_600_000)
    p.rewindClock(60_000)
    p.setPhoneCount(3)
    const c = await createPhone(PLAYER_SCENARIOS['iiw-marcus']!, { index: 2 })
    p.attach(c.controller)
    const clocks = p.inspect().map((i) => (i.connectivity as { clock: string }).clock)
    expect(clocks).toEqual(['behind', 'behind', 'behind'])
    expect(new Set(p.inspect().map((i) => i.now)).size).toBe(1)
    p.advanceClock(60_000)
    expect(p.inspect().map((i) => (i.connectivity as { clock: string }).clock)).toEqual(['ok', 'ok', 'ok'])
  })

  it('a received message shows in the conversation', async () => {
    const { composition, controller } = await createPhone(PLAYER_SCENARIOS.iiw!, { index: 0 })
    controller.apply({ type: 'receive', key: 'c:priya', from: 'priya', text: 'from the transport' })
    await flush()
    const c = composition.port.stores.conversation('c:priya').get()
    expect(c.status).toBe('ready')
    expect(JSON.stringify(c)).toContain('from the transport')
  })

  it('biometrics unavailable: the keystore reports none', async () => {
    const { composition, controller } = await createPhone(PLAYER_SCENARIOS.locked!, { index: 0 })
    expect(await composition.port.identity.biometricAvailability()).toBe('fingerprint')
    controller.setFaults({ ...NO_FAULTS, biometric: 'unavailable' }, 0)
    expect(await composition.port.identity.biometricAvailability()).toBeNull()
    controller.setFaults(NO_FAULTS, 0)
    expect(await composition.port.identity.biometricAvailability()).toBe('fingerprint')
  })

  it('vault fault: writing the vault fails', async () => {
    const { composition, controller } = await createPhone(PLAYER_SCENARIOS['fresh-install']!, { index: 0 })
    controller.setFaults({ ...NO_FAULTS, vault: 'fails' }, 0)
    const id = composition.port.identity
    const r = await id.setup.reserve('setup', 'passphrase')
    if (!r.ok) throw new Error('reserve')
    const w = await id.setup.writeVault(r.value.ns, {
      mnemonic: secret(TEST_PHRASE.split(' ')) as unknown as Secret<Mnemonic>,
      protection: { mode: 'passphrase', passphrase: secret(HARNESS_PASSPHRASE) },
      profile: { name: 'Jonas Weber' },
      termsVersion: id.termsConsent().current,
    })
    expect(w.ok).toBe(false)
  })

  it('host-close fault: locking leaves the holder open; without it the holder closes', async () => {
    const run = async (hostClose: PlayerFaults['hostClose']) => {
      const { composition, controller } = await createPhone(PLAYER_SCENARIOS.iiw!, { index: 0 })
      expect(controller.inspect()).toMatchObject({ identity: 'unlocked', openHolders: 1 })
      controller.setFaults({ ...NO_FAULTS, hostClose }, 0)
      await composition.port.identity.lock('user')
      await flush()
      return controller.inspect()
    }
    expect(await run('ok')).toMatchObject({ identity: 'locked', openHolders: 0 })
    expect(await run('fails')).toMatchObject({ openHolders: 1 })
  })

  it('a catalog phone renders the set state on the iiw world', async () => {
    const { composition } = await createPhone(PLAYER_SCENARIOS.iiw!, { index: 0, catalog: 'unlock-passphrase' })
    expect(composition.flowOverride).toMatchObject({ flow: 'unlock' })
  })

  it('inspect carries no secrets', async () => {
    const { controller } = await createPhone(PLAYER_SCENARIOS.iiw!, { index: 0 })
    const text = JSON.stringify(controller.inspect())
    expect(text).not.toContain('abandon')
    expect(text).not.toContain(HARNESS_PASSPHRASE)
  })
})
