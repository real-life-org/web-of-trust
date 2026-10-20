// @vitest-environment node
// Verify in person (architecture §4.2 "Verifizieren", §7.2 "Übergangstests"): every row of the
// table reached through real events, guards and effects, against two (three) loopback devices on
// the real library. Rows the library 0.5.0 cannot produce (recognized at scan time, already-captured
// with a known contact, a failing counter-step) are reached over a port double and named as such.
import { afterAll, describe, expect, it } from 'vitest'
import type { AppPort, ContactId, Result } from '../../src/port'
import { secret } from '../../src/port'
import { virtualClock } from '../../src/platform/fake'
import type { FakeScanner } from '../../src/platform/fake'
import { verify, verifyStart, VERIFY_TABLE, type VerifyEvent, type VerifyState } from '../../src/flows/verify'
import { createFlowRunner, type FlowRunner } from '../../src/hooks/flow-runner'
import { bundleEvent, verifyExecutor } from '../../src/hooks/verify'
import { LOOPBACK_PHRASES, loopbackDevice, memoryCarrier, type LoopbackDevice } from '../../harness/loopback'
import { tableCoverage } from './world'

const cover = tableCoverage('verify', VERIFY_TABLE)
afterAll(() => undefined)

const T0 = Date.parse('2026-10-15T13:30:00-07:00')

async function world(n = 2) {
  const carrier = memoryCarrier()
  const clock = virtualClock(T0, 'America/Los_Angeles')
  const names = ['Al', 'Bea', 'Cem']
  const devices: LoopbackDevice[] = []
  for (let i = 0; i < n; i++) devices.push(await loopbackDevice({ carrier, id: names[i] ?? `d${i}`, name: names[i] ?? `d${i}`, words: LOOPBACK_PHRASES[i] ?? LOOPBACK_PHRASES[0], clock, seed: 31 + i * 7 }))
  const settle = async () => {
    for (let i = 0; i < 4; i++) {
      await carrier.settled()
      for (const d of devices) await d.port.session()?.idle()
      await new Promise((r) => setTimeout(r, 0))
    }
  }
  return { carrier, clock, devices, settle }
}

interface Flow {
  readonly runner: FlowRunner<VerifyState, VerifyEvent>
  readonly scanner: FakeScanner
  state(): VerifyState
  send(e: VerifyEvent): void
  until(name: VerifyState['name']): Promise<VerifyState>
  abortScan(): void
}

function flow(d: LoopbackDevice, port: AppPort = d.port): Flow {
  const scans = { current: null as AbortController | null }
  const scanner = d.platform.scanner as FakeScanner
  const r = cover.track(createFlowRunner(verify, verifyStart(), verifyExecutor(port, d.platform, scans), d.platform))
  const push = () => {
    const e = bundleEvent(port)
    if (e) r.send(e)
  }
  port.stores.contacts.subscribe(push)
  port.stores.decisions.subscribe(push)
  r.subscribe(() => {
    if (r.get().name !== 'scanning') scans.current?.abort()
  })
  push()
  return {
    runner: r,
    scanner,
    state: () => r.get(),
    send: (e) => r.send(e),
    abortScan: () => scans.current?.abort(),
    async until(name) {
      for (let i = 0; i < 400; i++) {
        if (r.get().name === name) return r.get()
        await new Promise((x) => setTimeout(x, 5))
      }
      throw new Error(`verify: expected ${name}, still ${r.get().name}`)
    },
  }
}

function decisionsOf(d: LoopbackDevice) {
  const v = d.port.stores.decisions.get()
  if (v.status !== 'ready') throw new Error('decisions not ready')
  return v.value.flatMap((x) => (x.kind === 'encounter-confirm' ? [x] : []))
}

const qrOf = (f: Flow): string => {
  const s = f.state()
  if (!s.card) throw new Error('no card shown')
  return s.card.qr
}

describe('verify transitions', () => {
  it('scanner offline, optical return path, displayer captures and counters; both reach success', async () => {
    const { carrier, clock, devices, settle } = await world()
    const [A, B] = devices as [LoopbackDevice, LoopbackDevice]
    const fb = flow(B)
    await fb.until('ready')
    carrier.setOnline('Al', false)
    const fa = flow(A)
    await fa.until('ready')
    fa.scanner.source = () => qrOf(fb)
    fa.send({ type: 'scan' })
    await fa.until('confirm')
    expect(fa.state()).toMatchObject({ name: 'confirm', preview: { role: 'displayed', name: 'Bea' } })
    fa.send({ type: 'yes' })
    await fa.until('waiting')
    clock.advance(2200)
    await expect.poll(() => (fa.state() as { waitLong?: boolean }).waitLong).toBe(true)
    fa.send({ type: 'keepWaiting' })
    expect(fa.state()).toMatchObject({ name: 'waiting', waitLong: false })
    clock.advance(2200)
    await expect.poll(() => (fa.state() as { waitLong?: boolean }).waitLong).toBe(true)
    fa.send({ type: 'showCode' })
    const fallback = await fa.until('fallback')
    const sentQr = (fallback as Extract<VerifyState, { name: 'fallback' }>).sentQr
    // B points the camera at A's fallback code
    fb.scanner.source = () => sentQr
    fb.send({ type: 'scan' })
    await fb.until('confirm')
    expect(fb.state()).toMatchObject({ preview: { role: 'sent', name: 'Al' } })
    fb.send({ type: 'yes' })
    await fb.until('confirmationRequired')
    fb.send({ type: 'accept' })
    await fb.until('counterPending')
    carrier.setOnline('Al', true)
    await settle()
    await fb.until('success')
    await fa.until('success')
    fa.send({ type: 'done' })
    expect(fa.state()).toMatchObject({ name: 'exit', to: 'chat' })
  })

  it('scanner online: the displayer confirms in the conversation, the scanner sees mutual while waiting; the shown code is renewed after use', async () => {
    const { devices, settle } = await world()
    const [A, B] = devices as [LoopbackDevice, LoopbackDevice]
    const fb = flow(B)
    await fb.until('ready')
    const firstQr = qrOf(fb)
    const fa = flow(A)
    await fa.until('ready')
    fa.scanner.source = () => firstQr
    fa.send({ type: 'scan' })
    await fa.until('confirm')
    fa.send({ type: 'yes' })
    await fa.until('waiting')
    await settle()
    // B's open code was used: B shows a new one (ready.bundle.consumed)
    await expect.poll(() => fb.state().card?.qr ?? null).not.toBe(firstQr)
    expect(fb.state().name).toBe('ready')
    const [decision] = decisionsOf(B)
    expect((await B.port.trust.counterVerify(decision!.contactId).done).ok).toBe(true)
    await settle()
    await fa.until('success')
    // scanning the same displayed code again is refused by the library
    const fa2 = flow(A)
    await fa2.until('ready')
    fa2.scanner.source = () => firstQr
    fa2.send({ type: 'manual' })
    fa2.send({ type: 'text', text: firstQr })
    fa2.send({ type: 'submit' })
    await fa2.until('confirm')
    fa2.send({ type: 'yes' })
    await fa2.until('scanError')
    expect(fa2.state()).toMatchObject({ code: 'already-scanned' })
  })

  it('camera states: explain before the first prompt, denied with settings, unavailable, revoked, broken, cancelled', async () => {
    const { devices } = await world()
    const [A, B] = devices as [LoopbackDevice, LoopbackDevice]
    const fb = flow(B)
    await fb.until('ready')
    const fa = flow(A)
    await fa.until('ready')
    const s = fa.scanner
    s.camera = 'prompt'
    fa.send({ type: 'scan' })
    await fa.until('cameraExplain')
    fa.send({ type: 'back' })
    await fa.until('ready')
    fa.send({ type: 'scan' })
    await fa.until('cameraExplain')
    s.source = () => null
    fa.send({ type: 'continue' })
    await fa.until('scanning')
    fa.send({ type: 'back' })
    await fa.until('ready')
    s.camera = 'denied'
    fa.send({ type: 'scan' })
    await fa.until('cameraDenied')
    fa.send({ type: 'openSettings' })
    await expect.poll(() => s.settingsOpened).toBe(1)
    fa.send({ type: 'back' })
    await fa.until('ready')
    fa.send({ type: 'scan' })
    await fa.until('cameraDenied')
    fa.send({ type: 'manual' })
    await fa.until('manualEntry')
    fa.send({ type: 'back' })
    await fa.until('ready')
    s.camera = 'unavailable'
    fa.send({ type: 'scan' })
    await fa.until('cameraUnavailable')
    fa.send({ type: 'back' })
    await fa.until('ready')
    fa.send({ type: 'scan' })
    await fa.until('cameraUnavailable')
    fa.send({ type: 'manual' })
    await fa.until('manualEntry')
    fa.send({ type: 'back' })
    s.camera = 'revoked'
    fa.send({ type: 'scan' })
    await fa.until('cameraDenied')
    fa.send({ type: 'back' })
    s.camera = 'broken'
    fa.send({ type: 'scan' })
    await fa.until('cameraUnavailable')
    fa.send({ type: 'back' })
    s.camera = 'ok'
    s.source = () => null
    fa.send({ type: 'scan' })
    await fa.until('scanning')
    fa.abortScan()
    await fa.until('ready')
    fa.send({ type: 'back' })
    expect(fa.state()).toMatchObject({ name: 'exit', to: 'back' })
  })

  it('preview: own code, garbage, not this person; scan errors go back to ready', async () => {
    const { devices } = await world()
    const [A, B] = devices as [LoopbackDevice, LoopbackDevice]
    const fb = flow(B)
    await fb.until('ready')
    const fa = flow(A)
    await fa.until('ready')
    fa.scanner.source = () => qrOf(fa)
    fa.send({ type: 'scan' })
    await fa.until('scanError')
    expect(fa.state()).toMatchObject({ code: 'card-self' })
    fa.send({ type: 'retry' })
    await fa.until('ready')
    fa.send({ type: 'manual' })
    fa.send({ type: 'text', text: 'not a code' })
    fa.send({ type: 'submit' })
    await fa.until('scanError')
    expect(fa.state()).toMatchObject({ code: 'card-invalid' })
    fa.send({ type: 'back' })
    await fa.until('ready')
    fa.scanner.source = () => qrOf(fb)
    fa.send({ type: 'scan' })
    await fa.until('confirm')
    fa.send({ type: 'notThem' })
    await fa.until('ready')
  })

  it('the shown code is renewed when it expires; a failed show can be retried', async () => {
    const { clock, devices } = await world()
    const [A] = devices as [LoopbackDevice]
    const fa = flow(A)
    await fa.until('ready')
    const first = qrOf(fa)
    clock.advance(5 * 60_000 + 1000)
    await expect.poll(() => fa.state().card?.qr ?? null).not.toBe(first)
    await fa.until('ready')
    await A.port.runtime.lock('user')
    const locked = flow(A)
    await locked.until('showing')
    await expect.poll(() => (locked.state() as { error?: boolean }).error).toBe(true)
    await A.port.runtime.unlock.passphrase(secret('harness passphrase'))
    await A.port.runtime.unlock.open()
    locked.send({ type: 'retry' })
    await locked.until('ready')
  })

  it('capture: a sent card for someone else is refused; a second capture of the same card lands in ready with a hint', async () => {
    const { carrier, devices, settle } = await world(3)
    const [A, B, C] = devices as [LoopbackDevice, LoopbackDevice, LoopbackDevice]
    carrier.setOnline('Al', false)
    const shown = await B.port.trust.showCard().done
    if (!shown.ok) throw new Error('show')
    const scanned = await A.port.trust.confirmCard(shown.value.qr).done
    if (!scanned.ok) throw new Error('scan')
    const sent = await A.port.trust.sentCardFor(scanned.value.contactId!)
    if (!sent.ok) throw new Error('sent')
    const fc = flow(C)
    await fc.until('ready')
    fc.scanner.source = () => sent.value.qr
    fc.send({ type: 'scan' })
    await fc.until('confirm')
    fc.send({ type: 'yes' })
    await fc.until('scanError')
    // B captures twice: the second capture finds nothing new (N9); B declines the first, leaves the second
    const fb = flow(B)
    await fb.until('ready')
    fb.scanner.source = () => sent.value.qr
    fb.send({ type: 'scan' })
    await fb.until('confirm')
    fb.send({ type: 'yes' })
    await fb.until('confirmationRequired')
    fb.send({ type: 'decline' })
    await fb.until('ready')
    await settle()
    fb.send({ type: 'scan' })
    await fb.until('confirm')
    fb.send({ type: 'yes' })
    await expect.poll(() => (fb.state() as { hint?: string | null }).hint ?? null).toBe('already-captured')
  })

  it('leaving: waiting, fallback, counter pending and an open confirmation all go to the conversation', async () => {
    const { carrier, devices } = await world()
    const [A, B] = devices as [LoopbackDevice, LoopbackDevice]
    carrier.setOnline('Al', false)
    const fb = flow(B)
    await fb.until('ready')
    const fa = flow(A)
    await fa.until('ready')
    fa.scanner.source = () => qrOf(fb)
    fa.send({ type: 'scan' })
    await fa.until('confirm')
    fa.send({ type: 'yes' })
    await fa.until('waiting')
    fa.send({ type: 'leave' })
    expect(fa.state()).toMatchObject({ name: 'exit', to: 'chat' })
    const contactId = (fa.state() as { contactId: ContactId }).contactId
    const sent = await A.port.trust.sentCardFor(contactId)
    if (!sent.ok) throw new Error('sent')
    const fa2 = flow(A)
    await fa2.until('ready')
    // the fallback reached from a second waiting: scan another code of B
    const shown = await B.port.trust.showCard().done
    if (!shown.ok) throw new Error('show')
    fa2.scanner.source = () => shown.value.qr
    fa2.send({ type: 'scan' })
    await fa2.until('confirm')
    fa2.send({ type: 'yes' })
    await fa2.until('waiting')
    fa2.send({ type: 'showCode' })
    await fa2.until('fallback')
    fa2.send({ type: 'leave' })
    expect(fa2.state().name).toBe('exit')
    fb.scanner.source = () => sent.value.qr
    fb.send({ type: 'scan' })
    await fb.until('confirm')
    fb.send({ type: 'yes' })
    await fb.until('confirmationRequired')
    fb.send({ type: 'leave' })
    expect(fb.state().name).toBe('exit')
    const fb2 = flow(B)
    await fb2.until('ready')
    const [decision] = decisionsOf(B)
    expect(decision).toBeDefined()
    expect((await B.port.trust.counterVerify(decision!.contactId).done).ok).toBe(true)
    // a capture of the second sent card ends in counter pending; leaving it goes to the chat
    const sent2 = await A.port.trust.sentCardFor((fa2.state() as { contactId: ContactId }).contactId)
    if (!sent2.ok) throw new Error('sent2')
    fb2.scanner.source = () => sent2.value.qr
    fb2.send({ type: 'scan' })
    await fb2.until('confirm')
    fb2.send({ type: 'yes' })
    await fb2.until('confirmationRequired')
    fb2.send({ type: 'accept' })
    await fb2.until('counterPending')
    fb2.send({ type: 'leave' })
    expect(fb2.state().name).toBe('exit')
  })
})

// ── rows the library 0.5.0 does not produce: a port double over the real device ─────────────────
describe('verify transitions over a port double', () => {
  const double = (d: LoopbackDevice, over: { confirm?: () => Result<unknown>; counter?: () => Result<unknown>; sent?: () => Result<unknown>; contact?: ContactId }) => {
    const p = d.port
    const contactStore = over.contact ? p.stores.contact(over.contact) : null
    void contactStore
    return {
      ...p,
      trust: {
        ...p.trust,
        ...(over.confirm ? { confirmCard: () => ({ actId: 'x' as never, done: Promise.resolve(over.confirm!() as never) }) } : {}),
        ...(over.counter ? { counterVerify: () => ({ actId: 'x' as never, done: Promise.resolve(over.counter!() as never) }) } : {}),
        ...(over.sent ? { sentCardFor: () => Promise.resolve(over.sent!() as never) } : {}),
      },
    } as AppPort
  }

  it('recognized at scan time goes to the conversation; a failing sent card stays in waiting', async () => {
    const { devices } = await world()
    const [A, B] = devices as [LoopbackDevice, LoopbackDevice]
    const shown = await B.port.trust.showCard().done
    if (!shown.ok) throw new Error('show')
    const fa = flow(A, double(A, { confirm: () => ({ ok: true, value: { kind: 'recognized', contactId: 'c1' } }) }))
    await fa.until('ready')
    fa.scanner.source = () => shown.value.qr
    fa.send({ type: 'scan' })
    await fa.until('confirm')
    fa.send({ type: 'yes' })
    await fa.until('exit')
    expect(fa.state()).toMatchObject({ to: 'chat', recognized: true })
    const fa2 = flow(A, double(A, { confirm: () => ({ ok: true, value: { kind: 'scanned', contactId: 'c1' } }), sent: () => ({ ok: false, error: { kind: 'refused', code: 'nothing-to-counter' } }) }))
    await fa2.until('ready')
    fa2.scanner.source = () => shown.value.qr
    fa2.send({ type: 'scan' })
    await fa2.until('confirm')
    fa2.send({ type: 'yes' })
    await fa2.until('waiting')
    fa2.send({ type: 'showCode' })
    await expect.poll(() => (fa2.state() as { waitLong?: boolean }).waitLong).toBe(true)
    expect(fa2.state().name).toBe('waiting')
  })

  it('already captured with a known contact: open decision, own step issued, mutual; a failing counter-step keeps the decision', async () => {
    const { carrier, devices, settle } = await world()
    const [A, B] = devices as [LoopbackDevice, LoopbackDevice]
    carrier.setOnline('Al', false)
    const shown = await B.port.trust.showCard().done
    if (!shown.ok) throw new Error('show')
    const scanned = await A.port.trust.confirmCard(shown.value.qr).done
    if (!scanned.ok) throw new Error('scan')
    const sent = await A.port.trust.sentCardFor(scanned.value.contactId!)
    if (!sent.ok) throw new Error('sent')
    // B really captured it once: record and open decision, nothing issued
    const first = await B.port.trust.confirmCard(sent.value.qr).done
    if (!first.ok || first.value.kind !== 'captured') throw new Error('capture')
    const bContact = first.value.contactId
    const again = { ok: true, value: { kind: 'already-captured', contactId: bContact } } as const
    const fb = flow(B, double(B, { confirm: () => again, counter: () => ({ ok: false, error: { kind: 'infra', code: 'transport', retryable: true } }) }))
    await fb.until('ready')
    fb.scanner.source = () => sent.value.qr
    fb.send({ type: 'scan' })
    await fb.until('confirm')
    fb.send({ type: 'yes' })
    await fb.until('confirmationRequired')
    fb.send({ type: 'accept' })
    await expect.poll(() => (fb.state() as { busy?: boolean }).busy).toBe(false)
    expect(fb.state().name).toBe('confirmationRequired')
    // the real counter-step: own credential issued, A's acceptance waits for A's bundle
    expect((await B.port.trust.counterVerify(bContact).done).ok).toBe(true)
    const fb2 = flow(B, double(B, { confirm: () => again }))
    await fb2.until('ready')
    fb2.scanner.source = () => sent.value.qr
    fb2.send({ type: 'scan' })
    await fb2.until('confirm')
    fb2.send({ type: 'yes' })
    await fb2.until('counterPending')
    carrier.setOnline('Al', true)
    await settle()
    await fb2.until('success')
    const fb3 = flow(B, double(B, { confirm: () => again }))
    await fb3.until('ready')
    fb3.scanner.source = () => sent.value.qr
    fb3.send({ type: 'scan' })
    await fb3.until('confirm')
    fb3.send({ type: 'yes' })
    await fb3.until('success')
    expect(fb3.state()).toMatchObject({ isNew: false })
  })
})
