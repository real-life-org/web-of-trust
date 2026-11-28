// @vitest-environment node
// Verify in person (architecture §4.2 "Verifizieren", §7.2 "Übergangstests"): every row of the
// table reached through real events, guards and effects, against two (three) loopback devices on
// the real library. Rows the library 0.5.0 cannot produce (recognized at scan time) and injected
// failures and races (a failing counter-step or sent card, mutual before a result) are reached over a
// port double and named as such.
import { afterAll, describe, expect, it } from 'vitest'
import type { AppPort, BackRead, BackShow, CardPreview, Connection, ConnectionId, Connectivity, ContactId, DecisionId, Loadable, Result } from '../../src/port'
import { ready, revision, secret, writableStore } from '../../src/port'
import { virtualClock } from '../../src/platform/fake'
import type { FakeScanner } from '../../src/platform/fake'
import { loginLink } from '../../src/lib/login-request'
import { BACK_AFTER_MS, verify, verifyStart, VERIFY_TABLE, WAIT_LONG_MS, type VerifyEvent, type VerifyState } from '../../src/flows/verify'
import { createFlowRunner, type FlowRunner } from '../../src/hooks/flow-runner'
import { bundleEvent, carrierInReach, verifyExecutor, verifyLifetime } from '../../src/hooks/verify'
import { connectionOf } from '../../src/adapters/rltp/projection'
import { LOOPBACK_PHRASES, loopbackDevice, memoryCarrier, type LoopbackDevice } from '../../harness/loopback'
import { mediatorDouble, phoneNet } from '../../harness/mediator-double'
import { CARRIER_TICK_MS } from '../../src/adapters/rltp'
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
  rows(): readonly string[]
  readonly scanner: FakeScanner
  state(): VerifyState
  send(e: VerifyEvent): void
  until(name: VerifyState['name']): Promise<VerifyState>
  abortScan(): void
}

function flow(d: LoopbackDevice, port: AppPort = d.port): Flow {
  const scans = { current: null as AbortController | null }
  const scanner = d.platform.scanner as FakeScanner
  const r = cover.track(createFlowRunner(verify, verifyStart(), verifyExecutor(port, d.platform, scans, null), d.platform, { lifetime: verifyLifetime }))
  const push = () => {
    const e = bundleEvent(port)
    if (e) r.send(e)
  }
  port.stores.contacts.subscribe(push)
  port.stores.decisions.subscribe(push)
  port.stores.connections.subscribe(push)
  port.stores.connectivity.subscribe(push)
  r.subscribe(() => {
    if (r.get().name !== 'scanning') scans.current?.abort()
  })
  push()
  return {
    runner: r,
    rows: () => r.rows,
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

/** a ceremony as the port shows it, for the port doubles */
const conn = (over: Partial<Connection> & Pick<Connection, 'status'>): Connection => ({
  id: 'e1' as ConnectionId,
  role: 'responder',
  name: 'Bea',
  contactId: null,
  recognized: false,
  met: true,
  failure: null,
  closedAt: null,
  camera: true,
  accepted: false,
  backShown: false,
  relayed: true,
  theirDid: 'did:peer:2.bea',
  expiresAt: Number.MAX_SAFE_INTEGER,
  validUntil: Number.MAX_SAFE_INTEGER,
  decision: null,
  ...over,
})

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
    // the confirmation returns over the network: the "no answer yet" note only after a wait that lets
    // it come (20 s of device time, Anton 23.10.), never at once
    expect(WAIT_LONG_MS).toBe(20_000)
    clock.advance(WAIT_LONG_MS - 1)
    await new Promise((r) => setTimeout(r, 0))
    expect(fa.state()).toMatchObject({ name: 'waiting', waitLong: false })
    clock.advance(1)
    await expect.poll(() => (fa.state() as { waitLong?: boolean }).waitLong).toBe(true)
    fa.send({ type: 'keepWaiting' })
    expect(fa.state()).toMatchObject({ name: 'waiting', waitLong: false })
    clock.advance(WAIT_LONG_MS)
    await expect.poll(() => (fa.state() as { waitLong?: boolean }).waitLong).toBe(true)
    fa.send({ type: 'showCode' })
    const fallback = await fa.until('fallback')
    const sentQr = (fallback as Extract<VerifyState, { name: 'fallback' }>).sentQr
    // B points the camera at A's fallback code
    fb.scanner.source = () => sentQr
    fb.send({ type: 'scan' })
    // a sent card is asked once, before the counter-step is issued (Encounter C4, RLTP-ENC-5080, 5750);
    // taking it over is no issuance (RLTP-ENC-5710) and asks nothing (Anton 29.10., A1)
    await fb.until('confirmationRequired')
    expect(fb.state()).toMatchObject({ name: 'confirmationRequired', name2: 'Al', busy: false })
    expect(fb.rows()).toContain('previewing.result.sent')
    expect(fb.rows()).not.toContain('previewing.result.ok')
    fb.send({ type: 'accept' })
    await fb.until('counterPending')
    carrier.setOnline('Al', true)
    await settle()
    await fb.until('success')
    await fa.until('success')
    fa.send({ type: 'done' })
    expect(fa.state()).toMatchObject({ name: 'exit', to: 'chat' })
  })

  it('scanner online without a mediator: the bundle answers no card the flow knows (E9), the code stays; the displayer confirms in the conversation, the scanner sees mutual while waiting', async () => {
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
    // no card instance without a carrier offer: nothing names the card, nothing is inferred (E9)
    const [decision] = decisionsOf(B)
    expect(decision).toMatchObject({ answers: null })
    expect(fb.state()).toMatchObject({ name: 'ready', card: { qr: firstQr, card: null } })
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

  it('camera on the web: the browser asks itself, no explanation first (E3), also where every scan says prompt (Firefox, Safari)', async () => {
    const { devices } = await world()
    const [A, B] = devices as [LoopbackDevice, LoopbackDevice]
    const fb = flow(B)
    await fb.until('ready')
    const fa = flow(A)
    await fa.until('ready')
    const s = fa.scanner
    s.explainsBeforeAsking = false
    s.camera = 'prompt'
    s.source = () => null
    for (let i = 0; i < 2; i++) {
      fa.send({ type: 'scan' })
      await fa.until('scanning')
      expect(fa.runner.rows).not.toContain('cameraChecking.result.prompt.explain')
      fa.send({ type: 'back' })
      await fa.until('ready')
    }
  })

  it('camera states: explain before the first prompt (Android), denied with settings, unavailable, revoked, broken, cancelled', async () => {
    const { devices } = await world()
    const [A, B] = devices as [LoopbackDevice, LoopbackDevice]
    const fb = flow(B)
    await fb.until('ready')
    const fa = flow(A)
    await fa.until('ready')
    const s = fa.scanner
    s.explainsBeforeAsking = true
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

  it('a login request of a web app (experimental): scanned or typed, the flow hands it to the login page and stores nothing', async () => {
    const { devices } = await world(1)
    const [A] = devices as [LoopbackDevice]
    const login = loginLink(`openid://?${new URLSearchParams({ response_type: 'id_token', response_mode: 'direct_post', scope: 'openid', id_token_type: 'subject_signed', client_id: 'https://beispiel.org', response_uri: 'https://beispiel.org/antwort', nonce: 'n', state: 's' }).toString()}`)
    const fa = flow(A)
    await fa.until('ready')
    fa.scanner.source = () => login
    fa.send({ type: 'scan' })
    await fa.until('exit')
    expect(fa.state()).toMatchObject({ name: 'exit', to: 'login', raw: login })
    const fm = flow(A)
    await fm.until('ready')
    fm.send({ type: 'manual' })
    fm.send({ type: 'text', text: `  ${login}  ` })
    fm.send({ type: 'submit' })
    await fm.until('exit')
    expect(fm.state()).toMatchObject({ name: 'exit', to: 'login', raw: login })
  })

  it('a card link the app was opened with (#489): ready takes it as a step of its own, origin url; the camera says camera, typing says manual', async () => {
    const { devices } = await world()
    const [A, B] = devices as [LoopbackDevice, LoopbackDevice]
    const fb = flow(B)
    await fb.until('ready')
    const fa = flow(A)
    await fa.until('ready')
    // the link: no camera, no typing; the preview and the question are the same as after a scan
    fa.send({ type: 'link', raw: qrOf(fb) })
    expect(fa.state()).toMatchObject({ name: 'previewing', origin: 'url' })
    await fa.until('confirm')
    expect(fa.state()).toMatchObject({ name: 'confirm', origin: 'url', preview: { role: 'displayed', name: 'Bea' } })
    fa.send({ type: 'notThem' })
    await fa.until('ready')
    // the camera
    fa.scanner.source = () => qrOf(fb)
    fa.send({ type: 'scan' })
    await fa.until('confirm')
    expect(fa.state()).toMatchObject({ origin: 'camera' })
    fa.send({ type: 'notThem' })
    await fa.until('ready')
    // typed
    fa.send({ type: 'manual' })
    fa.send({ type: 'text', text: qrOf(fb) })
    fa.send({ type: 'submit' })
    await fa.until('confirm')
    expect(fa.state()).toMatchObject({ origin: 'manual' })
    // the origin travels into the issuance step
    fa.send({ type: 'yes' })
    expect(fa.state()).toMatchObject({ name: 'committing', origin: 'manual' })
    await fa.until('waiting')
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
    await fc.until('scanError')
    // B captures twice: the second capture finds nothing new (N9); "not now" on the first leaves the
    // decision open and sets it aside (E4: no decline on the shower's side)
    const fb0 = flow(B)
    await fb0.until('ready')
    fb0.scanner.source = () => sent.value.qr
    fb0.send({ type: 'scan' })
    await fb0.until('confirmationRequired')
    const open = (fb0.state() as { decision: string }).decision
    fb0.send({ type: 'notNow' })
    expect(fb0.state()).toMatchObject({ name: 'exit', to: 'back', deferred: open })
    await settle()
    expect(decisionsOf(B).map((d) => d.id)).toContain(open)
    // closed through the port (no decline on the confirmation screens, E4): nothing is open any more
    expect((await B.port.trust.decide(open as never, 'decline').done).ok).toBe(true)
    await settle()
    const fb = flow(B)
    await fb.until('ready')
    fb.scanner.source = () => sent.value.qr
    fb.send({ type: 'scan' })
    // nothing open for Al any more and no counter-step offered yet: the note says so (review 477, finding 3)
    await expect.poll(() => (fb.state() as { hint?: string | null }).hint ?? null).toBe('nothing-open')
  })

  it('declined, then the same sent card again: no false hint while nothing is open; the question before the counter-step once it is offered (review 477, finding 3)', async () => {
    const { carrier, devices, settle } = await world()
    const [A, B] = devices as [LoopbackDevice, LoopbackDevice]
    carrier.setOnline('Al', false)
    const shown = await B.port.trust.showCard().done
    if (!shown.ok) throw new Error('show')
    const scanned = await A.port.trust.confirmCard(shown.value.qr).done
    if (!scanned.ok) throw new Error('scan')
    const sent = await A.port.trust.sentCardFor(scanned.value.contactId!)
    if (!sent.ok) throw new Error('sent')
    const first = await B.port.trust.confirmCard(sent.value.qr).done
    if (!first.ok || first.value.kind !== 'captured') throw new Error('capture')
    // "Decline" in the conversation (A2): the request is closed here, nothing else changes
    expect((await B.port.trust.decide(first.value.decision, 'decline').done).ok).toBe(true)
    await settle()
    expect(decisionsOf(B)).toEqual([])
    // Al's credential has not arrived: the port offers no counter-step yet (met). The rescan says that
    // nothing is open, never "an open confirmation is in the conversation"
    const fb = flow(B)
    await fb.until('ready')
    fb.scanner.source = () => sent.value.qr
    fb.send({ type: 'scan' })
    await expect.poll(() => (fb.state() as { hint?: string | null }).hint ?? null).toBe('nothing-open')
    expect(fb.rows()).toContain('capturing.result.again.met')
    // Al comes online: his bundle lands on the record (RLTP-ENC-5740), the edge is incoming and the
    // counter-step offered. The same card now asks the question before it, as at the first scan
    carrier.setOnline('Al', true)
    await settle()
    expect(decisionsOf(B)).toEqual([])
    fb.send({ type: 'scan' })
    await fb.until('confirmationRequired')
    expect(fb.state()).toMatchObject({ contactId: first.value.contactId, decision: null, name2: 'Al' })
    expect(fb.rows()).toContain('capturing.result.again.counter')
    // "not now": nothing to set aside
    fb.send({ type: 'notNow' })
    expect(fb.state()).toMatchObject({ name: 'exit', to: 'back', deferred: null })
    const fb2 = flow(B)
    await fb2.until('ready')
    fb2.scanner.source = () => sent.value.qr
    fb2.send({ type: 'scan' })
    await fb2.until('confirmationRequired')
    fb2.send({ type: 'accept' })
    await settle()
    await fb2.until('success')
  })

  it('network before optics: the sent card of an encounter already taken in over the network names no contact; the note points to the conversation, where the request is open', async () => {
    const { devices, settle } = await world()
    const [A, B] = devices as [LoopbackDevice, LoopbackDevice]
    const shown = await B.port.trust.showCard().done
    if (!shown.ok) throw new Error('show')
    const scanned = await A.port.trust.confirmCard(shown.value.qr).done
    if (!scanned.ok) throw new Error('scan')
    await settle()
    expect(decisionsOf(B)).toHaveLength(1)
    const sent = await A.port.trust.sentCardFor(scanned.value.contactId!)
    if (!sent.ok) throw new Error('sent')
    const fb = flow(B)
    await fb.until('ready')
    fb.scanner.source = () => sent.value.qr
    fb.send({ type: 'scan' })
    await expect.poll(() => (fb.state() as { hint?: string | null }).hint ?? null).toBe('already-captured')
    expect(fb.rows()).toContain('capturing.result.again.none')
    expect(decisionsOf(B)).toHaveLength(1)
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
    await fb2.until('confirmationRequired')
    fb2.send({ type: 'accept' })
    await fb2.until('counterPending')
    fb2.send({ type: 'leave' })
    expect(fb2.state().name).toBe('exit')
  })
})

describe('verify transitions, mutual while the counter-step runs', () => {
  it('the scanner came online meanwhile: confirming makes the displayer mutual at once, the bundle ends the flow', async () => {
    const { carrier, devices, settle } = await world()
    const [A, B] = devices as [LoopbackDevice, LoopbackDevice]
    carrier.setOnline('Al', false)
    const shown = await B.port.trust.showCard().done
    if (!shown.ok) throw new Error('show')
    const scanned = await A.port.trust.confirmCard(shown.value.qr).done
    if (!scanned.ok) throw new Error('scan')
    const sent = await A.port.trust.sentCardFor(scanned.value.contactId!)
    if (!sent.ok) throw new Error('sent')
    const fb = flow(B)
    await fb.until('ready')
    fb.scanner.source = () => sent.value.qr
    fb.send({ type: 'scan' })
    await fb.until('confirmationRequired')
    carrier.setOnline('Al', true)
    await settle()
    fb.send({ type: 'accept' })
    await fb.until('success')
  })
})

/** a port's counter-step answered by the test: the contact's (`counterVerify`), and the acceptance of the
 *  request a screen shows (`decide(id, 'accept')`, #568); a decline stays the port's */
const counterStep = (p: AppPort, answer: () => Result<unknown>): Pick<AppPort['trust'], 'counterVerify' | 'decide'> => ({
  counterVerify: () => ({ actId: 'x' as never, done: Promise.resolve(answer() as never) }),
  decide: (id, choice, options) => (choice === 'accept' ? { actId: 'x' as never, done: Promise.resolve(answer() as never) } : p.trust.decide(id, choice, options)),
})

// ── rows the library 0.5.0 does not produce, and failures: a port double over the real device ──
describe('verify transitions over a port double', () => {
  const double = (d: LoopbackDevice, over: { confirm?: () => Result<unknown>; counter?: () => Result<unknown>; sent?: () => Result<unknown> | Promise<never>; contact?: ContactId }) => {
    const p = d.port
    const contactStore = over.contact ? p.stores.contact(over.contact) : null
    void contactStore
    return {
      ...p,
      trust: {
        ...p.trust,
        ...(over.confirm ? { confirmCard: () => ({ actId: 'x' as never, done: Promise.resolve(over.confirm!() as never) }) } : {}),
        ...(over.counter ? counterStep(p, over.counter) : {}),
        ...(over.sent ? { sentCardFor: () => Promise.resolve(over.sent!()) as never } : {}),
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
    // the repeated capture is real: the adapter maps the sent card back to its contact (N9); only the
    // failing counter-step comes from the double
    const fb = flow(B, double(B, { counter: () => ({ ok: false, error: { kind: 'infra', code: 'transport', retryable: true } }) }))
    await fb.until('ready')
    fb.scanner.source = () => sent.value.qr
    fb.send({ type: 'scan' })
    await fb.until('confirmationRequired')
    fb.send({ type: 'accept' })
    await expect.poll(() => (fb.state() as { busy?: boolean }).busy).toBe(false)
    expect(fb.state().name).toBe('confirmationRequired')
    // the real counter-step: own credential issued, A's acceptance waits for A's bundle
    expect((await B.port.trust.counterVerify(bContact).done).ok).toBe(true)
    const fb2 = flow(B)
    await fb2.until('ready')
    fb2.scanner.source = () => sent.value.qr
    fb2.send({ type: 'scan' })
    await fb2.until('counterPending')
    carrier.setOnline('Al', true)
    await settle()
    await fb2.until('success')
    const fb3 = flow(B)
    await fb3.until('ready')
    fb3.scanner.source = () => sent.value.qr
    fb3.send({ type: 'scan' })
    await fb3.until('success')
    // the same card read again: not new, and no second meeting either (nothing was joined)
    expect(fb3.state()).toMatchObject({ isNew: false, recognized: false })
  })

  it('mutual seen before the act result: committing goes to success; a bundle while the fallback loads goes to success', async () => {
    const { devices, settle } = await world()
    const [A, B] = devices as [LoopbackDevice, LoopbackDevice]
    const shown = await B.port.trust.showCard().done
    if (!shown.ok) throw new Error('show')
    const fa = flow(A, double(A, { confirm: () => ({ ok: true, value: { kind: 'scanned', contactId: 'x1' } }) }))
    await fa.until('ready')
    fa.scanner.source = () => shown.value.qr
    fa.send({ type: 'scan' })
    await fa.until('confirm')
    fa.send({ type: 'yes' })
    fa.send({ type: 'bundle', verifications: { x1: 'mutual' }, decisions: [] })
    await fa.until('success')
    // the fallback is loading (its card never comes) when the bundle says mutual
    const fa2 = flow(A, double(A, { confirm: () => ({ ok: true, value: { kind: 'scanned', contactId: 'x2' } }), sent: () => new Promise<never>(() => undefined) }))
    await fa2.until('ready')
    fa2.scanner.source = () => shown.value.qr
    fa2.send({ type: 'scan' })
    await fa2.until('confirm')
    fa2.send({ type: 'yes' })
    await fa2.until('waiting')
    fa2.send({ type: 'showCode' })
    await fa2.until('loadingFallback')
    fa2.send({ type: 'bundle', verifications: { x2: 'mutual' }, decisions: [] })
    await fa2.until('success')
    void settle
  })
})

// ── over the VTI mediator: the displayed card has an instance, the bundle names the card it answers (E9) ──
async function mediatorWorld(n = 2, ceremony?: 'shared-connect') {
  const med = mediatorDouble()
  // the double issues tokens on its own (real) clock: the device clock starts at the real time
  const clock = virtualClock(Date.now(), 'UTC')
  const names = ['Al', 'Bea', 'Cem']
  const devices: LoopbackDevice[] = []
  for (let i = 0; i < n; i++) {
    devices.push(await loopbackDevice({ carrier: { mediator: med }, id: names[i] ?? `d${i}`, name: names[i] ?? `d${i}`, words: LOOPBACK_PHRASES[i] ?? LOOPBACK_PHRASES[0], clock, seed: 61 + i * 7, ...(ceremony ? { ceremony } : {}) }))
  }
  const settle = async () => {
    let last = ''
    let calm = 0
    for (let i = 0; i < 400 && calm < 2; i++) {
      await med.settled()
      for (const d of devices) await d.port.session()?.idle()
      await new Promise((r) => setTimeout(r, 0))
      const busy = devices.reduce((x, d) => x + (d.port.session()?.transportBusy() ?? 0), 0)
      const now = JSON.stringify(devices.map((d) => d.port.session()?.models()?.revision))
      calm = busy === 0 && now === last ? calm + 1 : 0
      last = now
    }
  }
  const tick = async () => {
    clock.advance(CARRIER_TICK_MS)
    await settle()
  }
  /** until `ok` holds (the bundle crossing the mediator). First without moving the device clock: the
   *  mediator double's delivery takes real time, which on a slow machine outlasts the settle loop's rest, and a
   *  device clock moved meanwhile would pass the scanner's wait (BACK_AFTER_MS) on the speed of the machine.
   *  Only what does not arrive in real time gets carrier ticks */
  const until = async (ok: () => boolean, what: string) => {
    for (let i = 0; i < 200 && !ok(); i++) {
      await settle()
      await new Promise((r) => setTimeout(r, 25))
    }
    for (let i = 0; i < 12 && !ok(); i++) await tick()
    if (!ok()) throw new Error(`mediator world: never ${what}`)
  }
  return { med, clock, devices, settle, tick, until }
}

describe('verify transitions over the mediator: the shown card takes the bundle that answers it (E9)', () => {
  it('ready → the same screen asks "is this the person?"; confirm; success on both; "next person" shows a fresh card', async () => {
    const { devices, until } = await mediatorWorld()
    const [A, B] = devices as [LoopbackDevice, LoopbackDevice]
    const fb = flow(B)
    await fb.until('ready')
    const card = fb.state().card
    expect(card?.card).toEqual(expect.any(String))
    const fa = flow(A)
    await fa.until('ready')
    fa.scanner.source = () => card?.qr ?? null
    fa.send({ type: 'scan' })
    await fa.until('confirm')
    fa.send({ type: 'yes' })
    await fa.until('waiting')
    await until(() => fb.state().name === 'confirmIncoming', 'the takeover')
    expect(fb.state()).toMatchObject({ name: 'confirmIncoming', card: null, name2: 'Al', busy: false, failed: false })
    fb.send({ type: 'accept' })
    await fb.until('success')
    await until(() => fa.state().name === 'success', 'mutual at the scanner')
  }, 60_000)

  it('"not now" goes back to the list, the decision stays open and is set aside; a decision closed elsewhere gives a fresh card', async () => {
    const { devices, until, settle } = await mediatorWorld(3)
    const [A, B, C] = devices as [LoopbackDevice, LoopbackDevice, LoopbackDevice]
    const fb = flow(B)
    await fb.until('ready')
    const first = fb.state().card
    expect((await A.port.trust.confirmCard(first?.qr ?? '').done).ok).toBe(true)
    await until(() => fb.state().name === 'confirmIncoming', 'the takeover')
    const decision = (fb.state() as { decision: string }).decision
    fb.send({ type: 'notNow' })
    expect(fb.state()).toMatchObject({ name: 'exit', to: 'back', contactId: null, deferred: decision })
    expect(decisionsOf(B).map((d) => d.id)).toContain(decision)
    // a second flow, another scanner; the decision is closed in the conversation (declined there)
    const fb2 = flow(B)
    await fb2.until('ready')
    expect((await C.port.trust.confirmCard(fb2.state().card?.qr ?? '').done).ok).toBe(true)
    await until(() => fb2.state().name === 'confirmIncoming', 'the second takeover')
    const second = (fb2.state() as { decision: string }).decision
    expect(second).not.toBe(decision)
    expect((await B.port.trust.decide(second as never, 'decline').done).ok).toBe(true)
    await settle()
    await fb2.until('ready')
    expect(fb2.rows()).toContain('confirmIncoming.bundle.gone')
  }, 60_000)

  it('E8: a second scanner of the same card stays waiting; the shower has one decision', async () => {
    const { devices, until, tick } = await mediatorWorld(3)
    const [A, B, C] = devices as [LoopbackDevice, LoopbackDevice, LoopbackDevice]
    const fb = flow(B)
    await fb.until('ready')
    const qr = fb.state().card?.qr ?? ''
    const fa = flow(A)
    await fa.until('ready')
    fa.scanner.source = () => qr
    fa.send({ type: 'scan' })
    await fa.until('confirm')
    fa.send({ type: 'yes' })
    await fa.until('waiting')
    const fc = flow(C)
    await fc.until('ready')
    fc.scanner.source = () => qr
    fc.send({ type: 'scan' })
    await fc.until('confirm')
    fc.send({ type: 'yes' })
    await fc.until('waiting')
    await until(() => fb.state().name === 'confirmIncoming', 'the takeover')
    fb.send({ type: 'accept' })
    await fb.until('success')
    await until(() => fa.state().name === 'success', 'mutual at the first scanner')
    for (let i = 0; i < 4; i++) await tick()
    expect(fc.state().name).toBe('waiting')
    expect(decisionsOf(B)).toEqual([])
  }, 60_000)

  it('a failing counter-step keeps the question; a counter-step without the mutual bundle waits in counter pending', async () => {
    const { devices, until } = await mediatorWorld()
    const [A, B] = devices as [LoopbackDevice, LoopbackDevice]
    let fail = true
    const port = {
      ...B.port,
      trust: {
        ...B.port.trust,
        ...counterStep(B.port, () => (fail ? { ok: false, error: { kind: 'infra', code: 'transport', retryable: true } } : { ok: true, value: undefined })),
      },
    } as AppPort
    const fb = flow(B, port)
    await fb.until('ready')
    expect((await A.port.trust.confirmCard(fb.state().card?.qr ?? '').done).ok).toBe(true)
    await until(() => fb.state().name === 'confirmIncoming', 'the takeover')
    fb.send({ type: 'accept' })
    await expect.poll(() => (fb.state() as { failed?: boolean }).failed).toBe(true)
    expect(fb.state()).toMatchObject({ name: 'confirmIncoming', busy: false })
    fail = false
    fb.send({ type: 'accept' })
    await fb.until('counterPending')
  }, 60_000)

  it('review of #562: a counter-step refused because the request ended leaves the question: the shower gets a fresh code, the scanner the code screen', async () => {
    for (const code of ['decision-expired', 'decision-gone'] as const) {
      const refused = () => ({ ok: false, error: { kind: 'refused', code } }) as Result<unknown>
      // the shower: confirmIncoming
      {
        const { devices, until } = await mediatorWorld()
        const [A, B] = devices as [LoopbackDevice, LoopbackDevice]
        const port = { ...B.port, trust: { ...B.port.trust, ...counterStep(B.port, refused) } } as AppPort
        const fb = flow(B, port)
        const first = (await fb.until('ready')).card?.qr
        expect((await A.port.trust.confirmCard(first ?? '').done).ok).toBe(true)
        await until(() => fb.state().name === 'confirmIncoming', 'the takeover')
        fb.send({ type: 'accept' })
        await fb.until('ready')
        expect(fb.rows(), code).toContain('confirmIncoming.result.expired')
        expect(fb.state().card?.qr).not.toBe(first)
      }
      // the scanner of a sent card: confirmationRequired
      {
        const { carrier, devices } = await world()
        const [A, B] = devices as [LoopbackDevice, LoopbackDevice]
        carrier.setOnline('Al', false)
        const shown = await B.port.trust.showCard().done
        if (!shown.ok) throw new Error('show')
        const scanned = await A.port.trust.confirmCard(shown.value.qr).done
        if (!scanned.ok) throw new Error('scan')
        const sent = await A.port.trust.sentCardFor(scanned.value.contactId!)
        if (!sent.ok) throw new Error('sent')
        const fb = flow(B, { ...B.port, trust: { ...B.port.trust, ...counterStep(B.port, refused) } } as AppPort)
        await fb.until('ready')
        fb.scanner.source = () => sent.value.qr
        fb.send({ type: 'scan' })
        await fb.until('confirmationRequired')
        fb.send({ type: 'accept' })
        await fb.until('ready')
        expect(fb.rows(), code).toContain('confirmationRequired.result.expired')
        expect(fb.state()).toMatchObject({ name: 'ready', hint: 'nothing-open' })
      }
    }
  }, 120_000)
})


// ── the connection ceremony (shared-connect): the shown code is a trigger link, the scanner proposes,
//    the shower accepts or declines, the bundle's connections say how it ended ──
describe('verify transitions, the connection ceremony over the mediator', () => {
  const scanAndPropose = async (fa: Flow, fb: Flow) => {
    await fb.until('ready')
    const card = fb.state().card
    expect(card?.qr.startsWith('https://web-of-trust.de/t#')).toBe(true)
    await fa.until('ready')
    fa.scanner.source = () => card?.qr ?? null
    fa.send({ type: 'scan' })
    await fa.until('confirm')
    expect(fa.state()).toMatchObject({ preview: { role: 'displayed', name: 'Bea' }, origin: 'camera' })
    fa.send({ type: 'yes' })
    await fa.until('connecting')
    expect(fa.state()).toMatchObject({ role: 'scanner', name2: 'Bea', waitLong: false })
  }

  it('scan, propose, the shower accepts on the same screen before the scanner’s wait ends: both reach success, no back-code, no early contact', async () => {
    const { devices, until, settle } = await mediatorWorld(2, 'shared-connect')
    const [A, B] = devices as [LoopbackDevice, LoopbackDevice]
    const fa = flow(A)
    const fb = flow(B)
    await scanAndPropose(fa, fb)
    await until(() => fb.state().name === 'connectIncoming', 'the proposal at the shower')
    expect(fb.state()).toMatchObject({ card: null, name2: 'Al', busy: null, failed: false })
    expect(fa.state()).toMatchObject({ name: 'connecting', role: 'scanner' })
    expect((A.port.stores.contacts.get() as { value?: unknown[] }).value).toEqual([])
    fb.send({ type: 'accept' })
    expect(fb.state()).toMatchObject({ name: 'connectIncoming', busy: 'accept' })
    await settle()
    await until(() => fa.state().name === 'success' && fb.state().name === 'success', 'success on both')
    expect(fa.state()).toMatchObject({ name2: 'Bea', isNew: true })
    expect(fb.state()).toMatchObject({ name2: 'Al', isNew: true })
    expect(fb.rows()).toEqual(expect.arrayContaining(['ready.bundle.proposed', 'connectIncoming.accept']))
    expect(fb.rows().some((r) => r === 'connectIncoming.result.accepted' || r === 'connecting.bundle.complete')).toBe(true)
    expect(fa.rows()).toEqual(expect.arrayContaining(['scanner.wait']))
    expect(fa.rows().some((r) => r === 'scanner.end.complete' || r === 'scanner.accepted' || r === 'scanner.accepted.contact')).toBe(true)
    expect(fa.rows().some((r) => r === 'scanner.back' || r.startsWith('backing') || r.startsWith('backCode'))).toBe(false)
  }, 60_000)

  it('two that met meet again: the success turns to the known contact once the library joined the new one, re-met, and leaves to it', async () => {
    const { devices, until, settle, tick } = await mediatorWorld(2, 'shared-connect')
    const [A, B] = devices as [LoopbackDevice, LoopbackDevice]
    const meetOnce = async () => {
      const fa = flow(A)
      const fb = flow(B)
      await scanAndPropose(fa, fb)
      await until(() => fb.state().name === 'connectIncoming', 'the proposal at the shower')
      fb.send({ type: 'accept' })
      await settle()
      await until(() => fa.state().name === 'success' && fb.state().name === 'success', 'success on both')
      return { fa, fb }
    }
    const first = await meetOnce()
    const knownAtA = (first.fa.state() as Extract<VerifyState, { name: 'success' }>).contactId
    const knownAtB = (first.fb.state() as Extract<VerifyState, { name: 'success' }>).contactId
    first.fa.send({ type: 'done' })
    first.fb.send({ type: 'done' })
    for (let i = 0; i < 12; i++) await tick()
    const { fa, fb } = await meetOnce()
    expect(fa.state()).toMatchObject({ isNew: true, recognized: false })
    expect(fa.state()).not.toMatchObject({ contactId: knownAtA })
    // the continuity probe and mapping go back and forth as device time passes (Trust 6a.4)
    await until(() => fa.rows().includes('success.bundle.joined') && fb.rows().includes('success.bundle.joined'), 'the join on both')
    expect(fa.state()).toMatchObject({ name: 'success', contactId: knownAtA, name2: 'Bea', isNew: false, recognized: true })
    expect(fb.state()).toMatchObject({ name: 'success', contactId: knownAtB, name2: 'Al', isNew: false, recognized: true })
    fa.send({ type: 'done' })
    expect(fa.state()).toMatchObject({ name: 'exit', to: 'chat', contactId: knownAtA })
  }, 120_000)

  it('the shower declines: a fresh code there, "declined" at the scanner, then its own code again', async () => {
    const { devices, until } = await mediatorWorld(2, 'shared-connect')
    const [A, B] = devices as [LoopbackDevice, LoopbackDevice]
    const fa = flow(A)
    const fb = flow(B)
    await scanAndPropose(fa, fb)
    const first = fb.state().card?.qr
    await until(() => fb.state().name === 'connectIncoming', 'the proposal at the shower')
    fb.send({ type: 'decline' })
    await fb.until('ready')
    expect(fb.state().card?.qr).not.toBe(first)
    await until(() => fa.state().name === 'declined', 'the decline at the scanner')
    expect(fa.state()).toMatchObject({ name2: 'Bea' })
    fa.send({ type: 'done' })
    await fa.until('ready')
    expect(fb.rows()).toEqual(expect.arrayContaining(['connectIncoming.decline', 'connectIncoming.result.declined']))
    expect(fa.rows()).toEqual(expect.arrayContaining(['scanner.end.declined', 'declined.done']))
  }, 60_000)

  it('"not now" leaves the request open; one decided elsewhere gives a fresh code; a failing answer keeps the question; the scanner may leave', async () => {
    const { devices, until, settle } = await mediatorWorld(2, 'shared-connect')
    const [A, B] = devices as [LoopbackDevice, LoopbackDevice]
    const fa = flow(A)
    const fb = flow(B)
    await scanAndPropose(fa, fb)
    await until(() => fb.state().name === 'connectIncoming', 'the proposal at the shower')
    const decision = (fb.state() as { decision: string }).decision
    fb.send({ type: 'notNow' })
    expect(fb.state()).toMatchObject({ name: 'exit', to: 'back', deferred: decision })
    fa.send({ type: 'leave' })
    expect(fa.state()).toMatchObject({ name: 'exit', to: 'back', contactId: null })
    // a second scanner and a second code: the answer fails once (a port double), the question stays
    const { devices: d2, until: until2 } = await mediatorWorld(2, 'shared-connect')
    const [C, D] = d2 as [LoopbackDevice, LoopbackDevice]
    const failing: AppPort = { ...D.port, trust: { ...D.port.trust, decide: () => ({ actId: 'x' as never, done: Promise.resolve({ ok: false, error: { kind: 'infra', code: 'storage', retryable: true } } as never) }) } }
    const fd = flow(D, failing)
    await fd.until('ready')
    expect((await C.port.trust.confirmCard(fd.state().card?.qr ?? '', 'camera').done).ok).toBe(true)
    await until2(() => fd.state().name === 'connectIncoming', 'the proposal at the shower')
    fd.send({ type: 'accept' })
    await expect.poll(() => (fd.state() as { failed?: boolean }).failed).toBe(true)
    expect(fd.state()).toMatchObject({ name: 'connectIncoming', busy: null })
    // decided elsewhere (the list): declined there, the code is spent, a fresh one is shown
    const spent = fd.state().card
    expect(spent).toBeNull()
    expect((await D.port.trust.decide((fd.state() as unknown as { decision: never }).decision, 'decline').done).ok).toBe(true)
    await fd.until('ready')
    expect(fd.rows()).toEqual(expect.arrayContaining(['connectIncoming.result.failed', 'connectIncoming.bundle.gone']))
    expect(fb.rows()).toContain('connectIncoming.notNow')
    expect(fa.rows()).toContain('connecting.leave')
    await settle()
  }, 60_000)

  it('an accepted proposal whose last documents are still under way waits as the shower (the answer over a port double)', async () => {
    const { devices, until } = await mediatorWorld(2, 'shared-connect')
    const [A, B] = devices as [LoopbackDevice, LoopbackDevice]
    // the answer is taken and nothing completes yet
    const held: AppPort = { ...B.port, trust: { ...B.port.trust, decide: () => ({ actId: 'x' as never, done: Promise.resolve({ ok: true, value: undefined } as never) }) } }
    const fb = flow(B, held)
    await fb.until('ready')
    expect((await A.port.trust.confirmCard(fb.state().card?.qr ?? '', 'camera').done).ok).toBe(true)
    await until(() => fb.state().name === 'connectIncoming', 'the proposal at the shower')
    fb.send({ type: 'accept' })
    await fb.until('connecting')
    expect(fb.state()).toMatchObject({ role: 'shower', name2: 'Al', waitLong: false })
    expect(fb.rows()).toContain('connectIncoming.result.accepted')
  }, 60_000)

  it('an accept past the end of the answered code issues nothing: a fresh code is shown, the scanner scans again', async () => {
    const { clock, devices, until, settle } = await mediatorWorld(2, 'shared-connect')
    const [A, B] = devices as [LoopbackDevice, LoopbackDevice]
    const fb = flow(B)
    await fb.until('ready')
    const first = fb.state().card?.qr
    expect((await A.port.trust.confirmCard(first ?? '', 'camera').done).ok).toBe(true)
    await until(() => fb.state().name === 'connectIncoming', 'the proposal at the shower')
    clock.advance(12 * 60_000)
    fb.send({ type: 'accept' })
    await fb.until('ready')
    expect(fb.state().card?.qr).not.toBe(first)
    expect(fb.rows()).toContain('connectIncoming.result.expired')
    await settle()
    const connections = B.port.stores.connections.get()
    expect(connections.status === 'ready' && connections.value.some((c) => c.status === 'complete')).toBe(false)
  }, 60_000)

  it('over a port double: the other side’s error ends in the error screen; a ceremony complete without a contact leaves the flow', async () => {
    const { devices } = await world()
    const [A, B] = devices as [LoopbackDevice, LoopbackDevice]
    const shown = await B.port.trust.showCard().done
    if (!shown.ok) throw new Error('show')
    const run = async (end: Partial<Connection> & Pick<Connection, 'status' | 'contactId'>) => {
      const connections = writableStore<Loadable<readonly Connection[]>>(ready([], revision(1, 1, 1)))
      const port: AppPort = {
        ...A.port,
        stores: { ...A.port.stores, connections },
        trust: { ...A.port.trust, confirmCard: () => ({ actId: 'x' as never, done: Promise.resolve({ ok: true, value: { kind: 'proposed', connection: 'e1', contactId: null } } as never) }) },
      }
      const fa = flow(A, port)
      await fa.until('ready')
      fa.scanner.source = () => shown.value.qr
      fa.send({ type: 'scan' })
      await fa.until('confirm')
      fa.send({ type: 'yes' })
      await fa.until('connecting')
      connections.set(ready([conn({ camera: false, ...end })], revision(1, 2, 1)))
      return fa
    }
    const failed = await run({ status: 'failed', contactId: null })
    await failed.until('scanError')
    expect(failed.state()).toMatchObject({ code: 'connect-failed' })
    // complete without a card (a counterpart whose app gives no channel), as the port really projects it:
    // the core holds no contact, the port names the ceremony's list entry `connect:<id>`, the flow ends in the
    // success (behaviour from before the offline path, unchanged here; open point: the screen offers "Close")
    const real = connectionOf({ id: 'e1', role: 'responder', status: 'complete', link: { from: 'did:peer:2.x', id: 'e1', exp: 2_000_000_000, label: 'Bea' }, did: 'did:peer:2.y', theirDid: 'did:peer:2.x', theirPair: null, name: 'Bea', channel: 'scan', theirChannel: null, met: true, promptId: null, contactId: null, carrierNonce: null, failure: null, theirCredential: null, myCredential: {}, outbox: [], openedAt: 0, closedAt: 1 } as never, true)
    expect(real.contactId).toBe('connect:e1')
    const foreign = await run(real)
    expect(await foreign.until('success')).toMatchObject({ contactId: 'connect:e1' })
    expect(failed.rows()).toContain('scanner.end.failed')
    expect(foreign.rows()).toContain('scanner.end.complete')
    // the exit for a complete ceremony without any contact id stays in the machine; the port never projects it
    const bare = await run({ status: 'complete', contactId: null })
    await bare.until('exit')
    expect(bare.rows()).toContain('scanner.end.foreign')
  })
})


// ── the connection ceremony without a carrier (lib 0.22.0): the link carries the shower's card, the
//    scanner shows its back-code, the shower's camera reads it and the confirmation opens both contacts ──
describe('verify transitions, the connection ceremony without a carrier', () => {
  it('both offline: link, back-code, confirmation; the shower succeeds at once, the scanner once a carrier brings the rest', async () => {
    const med = mediatorDouble()
    const clock = virtualClock(Date.now(), 'UTC')
    const nets = [phoneNet(med.net), phoneNet(med.net)]
    const devices: LoopbackDevice[] = []
    for (const [i, name] of ['Al', 'Bea'].entries()) {
      devices.push(await loopbackDevice({ carrier: { mediator: { did: med.did, net: nets[i]!.net } }, id: name, name, words: LOOPBACK_PHRASES[i] ?? LOOPBACK_PHRASES[0], clock, seed: 91 + i * 7, ceremony: 'shared-connect' }))
    }
    const [A, B] = devices as [LoopbackDevice, LoopbackDevice]
    const online = (on: boolean) => devices.forEach((d, i) => (nets[i]!.setOnline(on), d.platform.network.set(on ? 'online' : 'offline')))
    const settle = async () => {
      for (let i = 0; i < 40; i++) {
        await med.settled()
        for (const d of devices) await d.port.session()?.idle()
        await new Promise((r) => setTimeout(r, 0))
      }
    }
    online(false)
    await settle()
    const fa = flow(A)
    const fb = flow(B)
    await fb.until('ready')
    const link = fb.state().card?.qr ?? ''
    await fa.until('ready')
    fa.scanner.source = () => link
    fa.send({ type: 'scan' })
    await fa.until('confirm')
    fa.send({ type: 'yes' })
    // no carrier in reach: the back-code at once; the scanner's contact exists from here on
    const back = (await fa.until('backCode')) as Extract<VerifyState, { name: 'backCode' }>
    expect(back).toMatchObject({ name2: 'Bea' })
    expect(back.qr).toContain('/vti/flow/shared-connect/0.1/back')
    await settle()
    expect(A.port.stores.contacts.get()).toMatchObject({ status: 'ready', value: [{ name: 'Bea' }] })
    // the flow opened anew on the same device and session (not a process restart) reads the same link with the
    // camera: the same back-code again, no second contact; typed in, the link stays spent
    const again = flow(A)
    await again.until('ready')
    again.scanner.source = () => link
    again.send({ type: 'scan' })
    expect(((await again.until('backCode')) as Extract<VerifyState, { name: 'backCode' }>).qr).toBe(back.qr)
    expect(again.rows()).toContain('scanner.back')
    const typedLink = flow(A)
    await typedLink.until('ready')
    typedLink.send({ type: 'manual' })
    typedLink.send({ type: 'text', text: link })
    typedLink.send({ type: 'submit' })
    expect(await typedLink.until('scanError')).toMatchObject({ code: 'code-used' })
    await settle()
    expect((A.port.stores.contacts.get() as { value?: unknown[] }).value).toHaveLength(1)
    // the back-code typed in or opened as a link at the shower opens nothing: only its camera counts
    fb.send({ type: 'manual' })
    fb.send({ type: 'text', text: back.qr })
    fb.send({ type: 'submit' })
    expect(await fb.until('scanError')).toMatchObject({ code: 'back-not-camera' })
    fb.send({ type: 'retry' })
    await fb.until('ready')
    fb.send({ type: 'link', raw: back.qr })
    expect(await fb.until('scanError')).toMatchObject({ code: 'back-not-camera' })
    fb.send({ type: 'retry' })
    await fb.until('ready')
    await settle()
    expect((B.port.stores.decisions.get() as { value?: unknown[] }).value).toEqual([])
    expect(fb.rows()).toContain('previewing.result.back.notCamera')
    // the shower's camera reads it: the confirmation on the same screen, then the success
    fb.scanner.source = () => back.qr
    fb.send({ type: 'scan' })
    await fb.until('connectIncoming')
    expect(fb.state()).toMatchObject({ name2: 'Al', busy: null })
    fb.send({ type: 'accept' })
    await fb.until('success')
    expect(fb.state()).toMatchObject({ name2: 'Al', isNew: true })
    // the scanner's code stays while it is shown; the carrier comes and completes the ceremony
    await settle()
    expect(fa.state().name).toBe('backCode')
    online(true)
    for (let i = 0; i < 8 && fa.state().name !== 'success'; i++) {
      clock.advance(CARRIER_TICK_MS)
      await settle()
    }
    expect(fa.state()).toMatchObject({ name: 'success', name2: 'Bea' })
    const contactsA = A.port.stores.contacts.get()
    const [cA] = contactsA.status === 'ready' ? contactsA.value : []
    expect((fa.state() as { contactId: string }).contactId).toBe(cA?.id)
    expect(fa.rows()).toEqual(expect.arrayContaining(['scanner.back', 'backing.result.ok', 'scanner.end.complete']))
    expect(fb.rows()).toEqual(expect.arrayContaining(['previewing.result.back']))
    expect(fb.rows()).toContain('readingBack.result.proposed')
    expect(fb.rows()).toContain('connecting.bundle.complete')
  }, 60_000)

  it('over a port double: every step of the scanner decided against the newest state of its ceremony', async () => {
    const { devices } = await world(2)
    const [A] = devices as [LoopbackDevice]
    const clockA = A.platform.clock as unknown as { advance(ms: number): void; now(): number }
    const link = 'https://web-of-trust.de/t#_from=x&_id=e1'
    const tick = () => new Promise((r) => setTimeout(r, 0))
    /** A reads a code with its camera (or as a link); the port double holds the ceremony `first` */
    const run = async (first: Partial<Connection> | null, opts: { offline?: boolean; carrier?: Connectivity['carrier']; origin?: 'camera' | 'url'; preview?: Partial<CardPreview>; back?: () => Promise<Result<BackShow>> } = {}) => {
      const connections = writableStore<Loadable<readonly Connection[]>>(ready([], revision(1, 1, 1)))
      const connectivity = writableStore<Connectivity>({ ...A.port.stores.connectivity.get(), network: opts.offline ? 'offline' : 'online', carrier: opts.carrier ?? 'connected' })
      let backs = 0
      const set = (c: Partial<Connection> & Pick<Connection, 'status'>, rev: number) => connections.set(ready([conn(c)], revision(1, rev, 1)))
      const port: AppPort = {
        ...A.port,
        stores: { ...A.port.stores, connections, connectivity },
        trust: {
          ...A.port.trust,
          previewCard: async () => ({ ok: true, value: { role: 'displayed', name: 'Mallory', knownContact: null, self: false, ...opts.preview } }),
          confirmCard: () => {
            // the proposal's ceremony is published before the act's result, as the session does
            if (first) set({ status: 'open', ...first }, 2)
            return { actId: 'x' as never, done: Promise.resolve({ ok: true, value: { kind: 'proposed', connection: 'e1', contactId: null } } as never) }
          },
          showBackCode: () => {
            backs++
            return { actId: 'y' as never, done: (opts.back ?? (async () => ({ ok: true, value: { kind: 'shown', qr: 'BACK', validUntil: Number.MAX_SAFE_INTEGER } })))() as never }
          },
        },
      }
      const fa = flow(A, port)
      await fa.until('ready')
      if (opts.preview?.answered) {
        if (first) set({ status: 'open', ...first }, 2)
        fa.scanner.source = () => link
        fa.send({ type: 'scan' })
      } else if (opts.origin === 'url') {
        fa.send({ type: 'link', raw: link })
        await fa.until('confirm')
        fa.send({ type: 'yes' })
      } else {
        fa.scanner.source = () => link
        fa.send({ type: 'scan' })
        await fa.until('confirm')
        fa.send({ type: 'yes' })
      }
      return { fa, set, connectivity, backs: () => backs }
    }

    // a carrier in reach, a relay in the link: wait; no acceptance within BACK_AFTER_MS: the back-code;
    // "keep waiting" waits again; a decline while the code is shown says the contact stays
    const shown = await run({})
    await shown.fa.until('connecting')
    expect(shown.fa.rows()).toContain('scanner.wait')
    // one millisecond before the deadline: no act yet; at the deadline: the code
    clockA.advance(BACK_AFTER_MS - 1)
    await tick()
    expect(shown.backs()).toBe(0)
    expect(shown.fa.state().name).toBe('connecting')
    clockA.advance(1)
    await shown.fa.until('backCode')
    shown.set({ status: 'open', backShown: true, contactId: 'c-bea' as ContactId }, 3)
    shown.fa.send({ type: 'keepWaiting' })
    expect(shown.fa.state()).toMatchObject({ name: 'connecting', role: 'scanner', waitLong: false })
    // a second "keep waiting" while it waits changes nothing (no 20 s wait)
    shown.fa.send({ type: 'keepWaiting' })
    expect(shown.fa.rows().filter((r) => r === 'connecting.keepWaiting')).toEqual([])
    clockA.advance(BACK_AFTER_MS)
    await shown.fa.until('backCode')
    expect(shown.fa.rows()).toEqual(expect.arrayContaining(['backCode.keepWaiting', 'scanner.back']))
    shown.set({ status: 'declined', contactId: 'c-bea' as ContactId }, 4)
    expect(await shown.fa.until('declined')).toMatchObject({ kept: true })

    // B1: the acceptance arrives over the carrier while the scanner waits (still open, the rest under way):
    // no back-code after the wait, the rest is awaited; then complete
    const acceptedWhileWaiting = await run({})
    await acceptedWhileWaiting.fa.until('connecting')
    acceptedWhileWaiting.set({ status: 'open', accepted: true }, 3)
    await tick()
    clockA.advance(BACK_AFTER_MS * 3)
    await tick()
    await tick()
    expect(acceptedWhileWaiting.fa.state()).toMatchObject({ name: 'connecting', role: 'scanner' })
    expect(acceptedWhileWaiting.backs()).toBe(0)
    expect(acceptedWhileWaiting.fa.rows()).toContain('scanner.accepted')
    acceptedWhileWaiting.set({ status: 'complete', accepted: true, contactId: 'c-bea' as ContactId }, 4)
    expect(await acceptedWhileWaiting.fa.until('success')).toMatchObject({ contactId: 'c-bea', name2: 'Bea' })
    // B1: the acceptance arrives while the code is shown: the code goes (the contact stands: the success)
    const acceptedWhileShown = await run({})
    await acceptedWhileShown.fa.until('connecting')
    clockA.advance(BACK_AFTER_MS)
    await acceptedWhileShown.fa.until('backCode')
    acceptedWhileShown.set({ status: 'open', accepted: true, backShown: true, contactId: 'c-bea' as ContactId }, 3)
    expect(await acceptedWhileShown.fa.until('success')).toMatchObject({ contactId: 'c-bea' })
    expect(acceptedWhileShown.fa.rows()).toContain('scanner.accepted.contact')
    // B1: the acceptance arrives while the code is being made: no code
    let resolveBack: (r: Result<BackShow>) => void = () => undefined
    const making = await run({}, { offline: true, back: () => new Promise((r) => (resolveBack = r)) })
    await making.fa.until('backing')
    making.set({ status: 'open', accepted: true, backShown: true, contactId: 'c-bea' as ContactId }, 3)
    await making.fa.until('success')
    resolveBack({ ok: true, value: { kind: 'shown', qr: 'BACK', validUntil: Number.MAX_SAFE_INTEGER } })
    await tick()
    expect(making.fa.state().name).toBe('success')

    // the ceremony ends while the code is made, before the act's result: complete, declined, failed
    for (const [status, to, contactId] of [['complete', 'success', 'c-bea'], ['declined', 'declined', null], ['failed', 'scanError', 'c-bea']] as const) {
      let resolve: (r: Result<BackShow>) => void = () => undefined
      const r = await run({}, { offline: true, back: () => new Promise((x) => (resolve = x)) })
      await r.fa.until('backing')
      r.set({ status, contactId: contactId as ContactId | null }, 3)
      await r.fa.until(to)
      resolve({ ok: true, value: { kind: 'shown', qr: 'BACK', validUntil: Number.MAX_SAFE_INTEGER } })
      await tick()
      expect(r.fa.state().name).toBe(to)
      if (status === 'failed') expect(r.fa.state()).toMatchObject({ code: 'connect-failed-kept' })
    }

    // a link without a relay: the back-code at once, also online; no carrier in reach: the same
    const noRelay = await run({ relayed: false })
    await noRelay.fa.until('backCode')
    const offline = await run({}, { offline: true })
    await offline.fa.until('backCode')
    // online, but the carrier unreachable or not configured: the same, at once
    for (const carrier of ['unreachable', 'not-configured'] as const) {
      const noCarrier = await run({}, { carrier })
      await noCarrier.fa.until('backCode')
      expect(noCarrier.fa.rows()).not.toContain('scanner.wait')
    }
    // a link opened as a link: waiting without a back-code; the long wait and "keep waiting"
    const viaLink = await run({ camera: false }, { origin: 'url' })
    await viaLink.fa.until('connecting')
    clockA.advance(WAIT_LONG_MS)
    await expect.poll(() => (viaLink.fa.state() as { waitLong?: boolean }).waitLong).toBe(true)
    viaLink.fa.send({ type: 'keepWaiting' })
    expect(viaLink.fa.state()).toMatchObject({ name: 'connecting', waitLong: false })
    expect(viaLink.fa.rows()).toEqual(expect.arrayContaining(['scanner.wait.link', 'connecting.result.long', 'connecting.keepWaiting']))
    expect(viaLink.backs()).toBe(0)

    // W4, B2: a resumption (the same link read again) takes the stored ceremony through the same step: its
    // name, not the scanned one; shown before → the code at once; accepted → no code; ended → its end
    const resumeShown = await run({ backShown: true, contactId: 'c-bea' as ContactId }, { preview: { answered: 'e1' as ConnectionId } })
    expect(await resumeShown.fa.until('backCode')).toMatchObject({ name2: 'Bea' })
    const resumeNoRelay = await run({ relayed: false }, { preview: { answered: 'e1' as ConnectionId } })
    await resumeNoRelay.fa.until('backCode')
    const resumeOffline = await run({}, { offline: true, preview: { answered: 'e1' as ConnectionId } })
    await resumeOffline.fa.until('backCode')
    const resumeWait = await run({}, { preview: { answered: 'e1' as ConnectionId } })
    expect(await resumeWait.fa.until('connecting')).toMatchObject({ name2: 'Bea' })
    const resumeAccepted = await run({ accepted: true }, { preview: { answered: 'e1' as ConnectionId } })
    await resumeAccepted.fa.until('connecting')
    clockA.advance(BACK_AFTER_MS)
    await tick()
    expect(resumeAccepted.backs()).toBe(0)
    const resumeDeclined = await run({ status: 'declined', contactId: 'c-bea' as ContactId }, { preview: { answered: 'e1' as ConnectionId } })
    expect(await resumeDeclined.fa.until('declined')).toMatchObject({ kept: true, name2: 'Bea' })
    const resumeTyped = flow(A, { ...A.port, trust: { ...A.port.trust, previewCard: async () => ({ ok: true, value: { role: 'displayed', name: 'Bea', knownContact: null, self: false, answered: 'e1' as ConnectionId } }) } })
    await resumeTyped.until('ready')
    resumeTyped.send({ type: 'link', raw: link })
    expect(await resumeTyped.until('scanError')).toMatchObject({ code: 'code-used' })

    // left at the code: to the conversation of the contact the code opened
    const left = await run({}, { offline: true })
    await left.fa.until('backCode')
    left.set({ status: 'open', backShown: true, contactId: 'c-bea' as ContactId }, 3)
    await tick()
    left.fa.send({ type: 'leave' })
    expect(await left.fa.until('exit')).toMatchObject({ to: 'chat', contactId: 'c-bea' })
    // the code past the end of the link it answers: not shown (checked before), and gone at its end
    // (the end without a contact in the projection says only the end; with the contact, that it stays)
    const ended = await run({}, { offline: true, back: async () => ({ ok: true, value: { kind: 'shown', qr: 'BACK', validUntil: clockA.now() - 1 } }) })
    expect(await ended.fa.until('scanError')).toMatchObject({ code: 'code-expired' })
    const expiring = await run({}, { offline: true, back: async () => ({ ok: true, value: { kind: 'shown', qr: 'BACK', validUntil: clockA.now() + 1000 } }) })
    await expiring.fa.until('backCode')
    expiring.set({ status: 'open', backShown: true, contactId: 'c-bea' as ContactId }, 3)
    await tick()
    clockA.advance(2000)
    expect(await expiring.fa.until('scanError')).toMatchObject({ code: 'back-expired' })
    expect(expiring.fa.rows()).toContain('backCode.expire')
    // a back-code that cannot be made: the reason; a failure of this device is said as one
    for (const [error, code] of [[{ kind: 'refused', code: 'code-too-long' }, 'code-too-long'], [{ kind: 'refused', code: 'no-card' }, 'no-card'], [{ kind: 'refused', code: 'code-used' }, 'code-expired'], [{ kind: 'infra', code: 'storage', retryable: true }, 'failed']] as const) {
      const refused = await run({}, { offline: true, back: async () => ({ ok: false, error: error as never }) })
      expect(await refused.fa.until('scanError')).toMatchObject({ code })
      expect(refused.fa.rows()).toContain('backing.result.failed')
    }
    // in the background no back-code act runs; back in front, the newest state decides
    const lifecycle = A.platform.lifecycle as unknown as { emit(s: 'active' | 'background'): void }
    lifecycle.emit('background')
    const away = await run({})
    await away.fa.until('connecting')
    clockA.advance(BACK_AFTER_MS)
    await away.fa.until('backing')
    await tick()
    expect(away.backs()).toBe(0)
    away.set({ status: 'open', accepted: true }, 3)
    lifecycle.emit('active')
    await away.fa.until('connecting')
    await tick()
    expect(away.backs()).toBe(0)
    expect(away.fa.rows()).toContain('scanner.accepted')
    // a ceremony unknown to the last bundle (cannot happen with the session) waits like a link
    const unknown = await run(null)
    await unknown.fa.until('connecting')
  })

  it('round 3: a missing state is no answer; the wait keeps its deadline and the person\'s choice; a late failure after an early success; the link path after the acceptance', async () => {
    const { devices } = await world(2)
    const [A] = devices as [LoopbackDevice]
    const clockA = A.platform.clock as unknown as { advance(ms: number): void; now(): number }
    const link = 'https://web-of-trust.de/t#_from=x&_id=e1'
    const tick = () => new Promise((r) => setTimeout(r, 0))
    const run = async (opts: { offline?: boolean; origin?: 'camera' | 'url'; back?: () => Promise<Result<BackShow>> } = {}) => {
      const connections = writableStore<Loadable<readonly Connection[]>>(ready([], revision(1, 1, 1)))
      const connectivity = writableStore<Connectivity>({ ...A.port.stores.connectivity.get(), network: opts.offline ? 'offline' : 'online', carrier: 'connected' })
      let backs = 0
      let rev = 2
      const set = (c: Partial<Connection> & Pick<Connection, 'status'>) => connections.set(ready([conn(c)], revision(1, rev++, 1)))
      const port: AppPort = {
        ...A.port,
        stores: { ...A.port.stores, connections, connectivity },
        trust: {
          ...A.port.trust,
          previewCard: async () => ({ ok: true, value: { role: 'displayed', name: 'Bea', knownContact: null, self: false } }),
          // the proposal's result comes before any bundle names its ceremony
          confirmCard: () => ({ actId: 'x' as never, done: Promise.resolve({ ok: true, value: { kind: 'proposed', connection: 'e1', contactId: null } } as never) }),
          showBackCode: () => {
            backs++
            return { actId: 'y' as never, done: (opts.back ?? (async () => ({ ok: true, value: { kind: 'shown', qr: 'BACK', validUntil: Number.MAX_SAFE_INTEGER } })))() as never }
          },
        },
      }
      const fa = flow(A, port)
      await fa.until('ready')
      if (opts.origin === 'url') fa.send({ type: 'link', raw: link })
      else {
        fa.scanner.source = () => link
        fa.send({ type: 'scan' })
      }
      await fa.until('confirm')
      fa.send({ type: 'yes' })
      return { fa, set, connectivity, backs: () => backs }
    }
    // no bundle names the ceremony yet: no answer either way (not the link path), the id is kept; the first
    // bundle, a camera scan without a carrier, gives the back-code at once
    const late = await run({ offline: true })
    expect(await late.fa.until('connecting')).toMatchObject({ connection: 'e1', phase: 'unknown' })
    clockA.advance(WAIT_LONG_MS)
    await tick()
    expect(late.fa.state()).toMatchObject({ name: 'connecting', phase: 'unknown', waitLong: false })
    late.set({ status: 'open' })
    await late.fa.until('backCode')
    expect(late.fa.rows()).toEqual(expect.arrayContaining(['scanner.unknown', 'connecting.bundle.known']))
    // the carrier goes away while it waits: the back-code at once
    const lost = await run()
    lost.set({ status: 'open' })
    await lost.fa.until('connecting')
    await expect.poll(() => (lost.fa.state() as { phase?: string }).phase).toBe('wait')
    lost.connectivity.set({ ...lost.connectivity.get(), network: 'offline' })
    await lost.fa.until('backCode')
    expect(lost.fa.rows()).toContain('connecting.carrier.lost')
    // "keep waiting" chosen: the carrier going away does not override it; the deadline does
    lost.fa.send({ type: 'keepWaiting' })
    expect(lost.fa.state()).toMatchObject({ phase: 'wait', kept: true })
    lost.connectivity.set({ ...lost.connectivity.get(), network: 'online' })
    lost.connectivity.set({ ...lost.connectivity.get(), network: 'offline' })
    await tick()
    expect(lost.fa.state().name).toBe('connecting')
    clockA.advance(BACK_AFTER_MS)
    await lost.fa.until('backCode')
    // back from the background after the deadline: the code at once, no new wait
    const lifecycle = A.platform.lifecycle as unknown as { emit(s: 'active' | 'background'): void }
    const away = await run()
    away.set({ status: 'open' })
    await expect.poll(() => (away.fa.state() as { phase?: string }).phase).toBe('wait')
    lifecycle.emit('background')
    clockA.advance(BACK_AFTER_MS)
    await away.fa.until('backing')
    lifecycle.emit('active')
    await away.fa.until('backCode')
    expect(away.fa.rows().filter((r) => r === 'scanner.wait')).toHaveLength(1)
    // the act ran nothing (accepted meanwhile): the code waits for the bundle that says so, then goes
    const notShown = await run({ offline: true, back: async () => ({ ok: true, value: { kind: 'not-shown', why: 'accepted' } }) })
    notShown.set({ status: 'open' })
    await notShown.fa.until('backing')
    await tick()
    expect(notShown.fa.state().name).toBe('backing')
    expect(notShown.fa.rows()).toContain('backing.result.notShown')
    notShown.set({ status: 'open', accepted: true })
    await notShown.fa.until('connecting')
    // an early success (the acceptance, the contact from the back-code, still open) shows a later failure
    const early = await run({ offline: true })
    early.set({ status: 'open' })
    await early.fa.until('backCode')
    early.set({ status: 'open', accepted: true, backShown: true, contactId: 'c-bea' as ContactId })
    expect(await early.fa.until('success')).toMatchObject({ connection: 'e1' })
    early.set({ status: 'failed', accepted: true, contactId: 'c-bea' as ContactId })
    expect(await early.fa.until('scanError')).toMatchObject({ code: 'connect-failed-kept' })
    expect(early.fa.rows()).toContain('success.bundle.failed')
    // the link path after the acceptance: a phase of its own, the long-wait timer ends with it
    const viaLink = await run({ origin: 'url' })
    viaLink.set({ status: 'open', camera: false })
    await expect.poll(() => (viaLink.fa.state() as { phase?: string }).phase).toBe('link')
    viaLink.set({ status: 'open', camera: false, accepted: true })
    await expect.poll(() => (viaLink.fa.state() as { phase?: string }).phase).toBe('accepted')
    clockA.advance(WAIT_LONG_MS)
    await tick()
    expect(viaLink.fa.state()).toMatchObject({ phase: 'accepted', waitLong: false })
  })

  it('round 4: the deadline set at the scan holds when the first state arrives; a way out of every wait; the read ceremony kept until it shows an answer', async () => {
    const { devices } = await world(2)
    const [A] = devices as [LoopbackDevice]
    const clockA = A.platform.clock as unknown as { advance(ms: number): void }
    const link = 'https://web-of-trust.de/t#_from=x&_id=e1'
    const tick = () => new Promise((r) => setTimeout(r, 0))
    const scanner = async (back?: () => Promise<Result<BackShow>>) => {
      const connections = writableStore<Loadable<readonly Connection[]>>(ready([], revision(1, 1, 1)))
      let rev = 2
      const set = (c: Partial<Connection> & Pick<Connection, 'status'>) => connections.set(ready([conn(c)], revision(1, rev++, 1)))
      const port: AppPort = {
        ...A.port,
        stores: { ...A.port.stores, connections },
        trust: {
          ...A.port.trust,
          previewCard: async () => ({ ok: true, value: { role: 'displayed', name: 'Bea', knownContact: null, self: false } }),
          confirmCard: () => ({ actId: 'x' as never, done: Promise.resolve({ ok: true, value: { kind: 'proposed', connection: 'e1', contactId: null } } as never) }),
          showBackCode: () => ({ actId: 'y' as never, done: (back ?? (async () => ({ ok: true, value: { kind: 'shown', qr: 'BACK', validUntil: Number.MAX_SAFE_INTEGER } })))() as never }),
        },
      }
      const fa = flow(A, port)
      await fa.until('ready')
      fa.scanner.source = () => link
      fa.send({ type: 'scan' })
      await fa.until('confirm')
      fa.send({ type: 'yes' })
      await fa.until('connecting')
      return { fa, set }
    }
    // the first state 15 s after the scan (online, a relay): the deadline passed, the code at once
    const late = await scanner()
    clockA.advance(15_000)
    await expect.poll(() => (late.fa.state() as { due?: boolean }).due).toBe(true)
    expect(late.fa.state()).toMatchObject({ phase: 'unknown' })
    late.set({ status: 'open' })
    await late.fa.until('backCode')
    expect(late.fa.rows()).toEqual(expect.arrayContaining(['connecting.unknown.due', 'connecting.bundle.known']))
    // the first state 5 s after the scan: the wait goes on with the deadline of the scan (7 s more, not 12)
    const early = await scanner()
    clockA.advance(5_000)
    await tick()
    early.set({ status: 'open' })
    await expect.poll(() => (early.fa.state() as { phase?: string }).phase).toBe('wait')
    clockA.advance(7_000)
    await early.fa.until('backCode')
    // a way out while the code is made
    let never: (r: Result<BackShow>) => void = () => undefined
    const making = await scanner(() => new Promise((r) => (never = r)))
    making.set({ status: 'open', relayed: false })
    await making.fa.until('backing')
    making.fa.send({ type: 'back' })
    await making.fa.until('exit')
    expect(making.fa.rows()).toContain('backing.leave')
    never({ ok: true, value: { kind: 'shown', qr: 'BACK', validUntil: Number.MAX_SAFE_INTEGER } })
    await tick()
    // the late result does not reopen the code
    expect(making.fa.state().name).toBe('exit')
    // the shower: an older bundle names the read ceremony open, without its confirmation: no answer yet, the
    // read ceremony is kept; the bundle with the confirmation opens it; and back is a way out meanwhile
    for (const leave of [false, true]) {
      const connections = writableStore<Loadable<readonly Connection[]>>(ready([conn({ status: 'open', role: 'inviter' })], revision(1, 2, 1)))
      const port: AppPort = {
        ...A.port,
        stores: { ...A.port.stores, connections },
        trust: { ...A.port.trust, previewCard: async () => ({ ok: true, value: { role: 'back', name: 'Bea', knownContact: null, self: false } }), readBackCode: async () => ({ ok: true, value: { kind: 'taken', connection: 'e1' as ConnectionId } }) },
      }
      const fb = flow(A, port)
      await fb.until('ready')
      fb.scanner.source = () => 'BACK'
      fb.send({ type: 'scan' })
      await expect.poll(() => (fb.state() as { connection?: string }).connection).toBe('e1')
      expect(fb.state().name).toBe('readingBack')
      if (leave) {
        fb.send({ type: 'back' })
        await fb.until('ready')
        expect(fb.rows()).toContain('readingBack.back')
      } else {
        connections.set(ready([conn({ status: 'open', role: 'inviter', decision: 'd1' as DecisionId })], revision(1, 3, 1)))
        expect(await fb.until('connectIncoming')).toMatchObject({ connection: 'e1', decision: 'd1' })
      }
    }
  })

  it('round 3: the shower keeps the read ceremony until a bundle names it', async () => {
    const { devices } = await world(2)
    const [A] = devices as [LoopbackDevice]
    const connections = writableStore<Loadable<readonly Connection[]>>(ready([], revision(1, 1, 1)))
    const port: AppPort = {
      ...A.port,
      stores: { ...A.port.stores, connections },
      trust: { ...A.port.trust, previewCard: async () => ({ ok: true, value: { role: 'back', name: 'Bea', knownContact: null, self: false } }), readBackCode: async () => ({ ok: true, value: { kind: 'taken', connection: 'e1' as ConnectionId } }) },
    }
    const fb = flow(A, port)
    await fb.until('ready')
    fb.scanner.source = () => 'BACK'
    fb.send({ type: 'scan' })
    expect(await fb.until('readingBack')).toBeDefined()
    await expect.poll(() => (fb.state() as { connection?: string }).connection).toBe('e1')
    connections.set(ready([conn({ status: 'open', role: 'inviter', decision: 'd1' as DecisionId })], revision(1, 5, 1)))
    expect(await fb.until('connectIncoming')).toMatchObject({ connection: 'e1', decision: 'd1' })
    expect(fb.rows()).toContain('readingBack.result.unknown')
  })

  it('maintainer review: a confirmation accepted elsewhere whose ceremony holds the contact is the success, no new code; "the contact stays" only with a contact', async () => {
    const A = await loopbackDevice({ carrier: memoryCarrier(), id: 'Al', name: 'Al', words: LOOPBACK_PHRASES[0], clock: virtualClock(T0, 'UTC'), seed: 151, ceremony: 'shared-connect' })
    // the shower: its confirmation disappears (accepted in the list), the ceremony open with the contact
    {
      const connections = writableStore<Loadable<readonly Connection[]>>(ready([], revision(1, 1, 1)))
      const decisions = writableStore(A.port.stores.decisions.get())
      const port: AppPort = { ...A.port, stores: { ...A.port.stores, decisions, connections } }
      const fb = flow(A, port)
      const shownCard = (await fb.until('ready')).card?.card ?? null
      connections.set(ready([conn({ status: 'open', role: 'inviter', decision: 'd1' as DecisionId })], revision(1, 2, 1)))
      decisions.set(ready([{ id: 'd1' as DecisionId, kind: 'connect-confirm', connection: 'e1' as ConnectionId, name: 'Bea', state: 'open', openedAt: 0, expiresAt: null, answers: { card: shownCard!, validUntil: Number.MAX_SAFE_INTEGER } }] as never, revision(99, 99, 99)))
      await fb.until('connectIncoming')
      const runBefore = fb.state().run
      connections.set(ready([conn({ status: 'open', role: 'inviter', accepted: true, contactId: 'c-bea' as ContactId })], revision(1, 3, 1)))
      decisions.set(ready([] as never, revision(99, 100, 99)))
      expect(await fb.until('success')).toMatchObject({ contactId: 'c-bea', connection: 'e1' })
      expect(fb.rows()).not.toContain('connectIncoming.bundle.gone')
      expect(fb.state().run).toBe(runBefore)
    }
    // the scanner: the link ended before any back-code was shown (no contact): only the end, no promise
    for (const [contactId, code] of [[null, 'code-expired'], ['c-bea', 'back-expired']] as const) {
      const connections = writableStore<Loadable<readonly Connection[]>>(ready([conn({ status: 'open', relayed: false, ...(contactId ? { backShown: true, contactId: contactId as ContactId } : {}) })], revision(1, 2, 1)))
      const port: AppPort = {
        ...A.port,
        stores: { ...A.port.stores, connections },
        trust: {
          ...A.port.trust,
          previewCard: async () => ({ ok: true, value: { role: 'displayed', name: 'Bea', knownContact: null, self: false } }),
          confirmCard: () => ({ actId: 'x' as never, done: Promise.resolve({ ok: true, value: { kind: 'proposed', connection: 'e1', contactId: null } } as never) }),
          showBackCode: () => ({ actId: 'y' as never, done: Promise.resolve({ ok: true, value: { kind: 'not-shown', why: 'expired' } } as never) }),
        },
      }
      const fa = flow(A, port)
      await fa.until('ready')
      fa.scanner.source = () => 'https://web-of-trust.de/t#_from=x&_id=e1'
      fa.send({ type: 'scan' })
      await fa.until('confirm')
      fa.send({ type: 'yes' })
      expect(await fa.until('scanError')).toMatchObject({ code })
    }
  })

  it('over a port double: the shower after its acceptance: the other side declines, fails, or completes without a contact', async () => {
    const A = await loopbackDevice({ carrier: memoryCarrier(), id: 'Al', name: 'Al', words: LOOPBACK_PHRASES[0], clock: virtualClock(T0, 'UTC'), seed: 141, ceremony: 'shared-connect' })
    for (const [status, to, rowId] of [['declined', 'declined', 'connecting.bundle.declined'], ['failed', 'scanError', 'connecting.bundle.failed'], ['complete', 'exit', 'connecting.bundle.foreign']] as const) {
      const connections = writableStore<Loadable<readonly Connection[]>>(ready([], revision(1, 1, 1)))
      const decisions = writableStore(A.port.stores.decisions.get())
      const port: AppPort = { ...A.port, stores: { ...A.port.stores, decisions, connections }, trust: { ...A.port.trust, decide: () => ({ actId: 'x' as never, done: Promise.resolve({ ok: true, value: undefined } as never) }) } }
      const fb = flow(A, port)
      const shownCard = (await fb.until('ready')).card?.card ?? null
      connections.set(ready([conn({ status: 'open', role: 'inviter', decision: 'd1' as DecisionId })], revision(1, 2, 1)))
      decisions.set(ready([{ id: 'd1' as DecisionId, kind: 'connect-confirm', connection: 'e1' as ConnectionId, name: 'Bea', state: 'open', openedAt: 0, expiresAt: null, answers: { card: shownCard!, validUntil: Number.MAX_SAFE_INTEGER } }] as never, revision(99, 99, 99)))
      await fb.until('connectIncoming')
      fb.send({ type: 'accept' })
      await fb.until('connecting')
      connections.set(ready([conn({ status, role: 'inviter', accepted: true })], revision(1, 3, 1)))
      await fb.until(to)
      expect(fb.rows()).toContain(rowId)
    }
  })

  it('review of #562: an answer refused because its request ended shows a fresh code, also when the bundle without the proposal came while it ran', async () => {
    const A = await loopbackDevice({ carrier: memoryCarrier(), id: 'Al', name: 'Al', words: LOOPBACK_PHRASES[0], clock: virtualClock(T0, 'UTC'), seed: 161, ceremony: 'shared-connect' })
    // [the refusal, whether the bundle without the proposal arrives while the act runs, the row]
    const cases = [
      ['decision-expired', false, 'connectIncoming.result.expired'],
      ['decision-expired', true, 'connectIncoming.result.expired'],
      ['decision-gone', true, 'connectIncoming.result.gone'],
      ['not-possible-yet', true, 'connectIncoming.result.gone'],
    ] as const
    for (const [code, goneMeanwhile, rowId] of cases) {
      const connections = writableStore<Loadable<readonly Connection[]>>(ready([], revision(1, 1, 1)))
      const decisions = writableStore(A.port.stores.decisions.get())
      let answer: (r: Result<unknown>) => void = () => undefined
      const port: AppPort = { ...A.port, stores: { ...A.port.stores, decisions, connections }, trust: { ...A.port.trust, decide: () => ({ actId: 'x' as never, done: new Promise((r) => (answer = r)) as never }) } }
      const fb = flow(A, port)
      const shownCard = (await fb.until('ready')).card?.card ?? null
      connections.set(ready([conn({ status: 'open', role: 'inviter', decision: 'd1' as DecisionId })], revision(1, 2, 1)))
      decisions.set(ready([{ id: 'd1' as DecisionId, kind: 'connect-confirm', connection: 'e1' as ConnectionId, name: 'Bea', state: 'open', openedAt: 0, expiresAt: null, answers: { card: shownCard!, validUntil: Number.MAX_SAFE_INTEGER } }] as never, revision(99, 99, 99)))
      await fb.until('connectIncoming')
      fb.send({ type: 'accept' })
      expect(fb.state()).toMatchObject({ name: 'connectIncoming', busy: 'accept' })
      if (goneMeanwhile) {
        connections.set(ready([conn({ status: 'open', role: 'inviter', decision: null })], revision(1, 3, 1)))
        decisions.set(ready([] as never, revision(99, 100, 99)))
        await new Promise((r) => setTimeout(r, 0))
        expect(fb.state()).toMatchObject({ name: 'connectIncoming', busy: 'accept' })
      }
      answer({ ok: false, error: { kind: 'refused', code } as never })
      await fb.until('ready')
      expect(fb.rows(), `${code} ${goneMeanwhile}`).toContain(rowId)
      expect(fb.rows()).not.toContain('connectIncoming.result.failed')
    }
  })

  it('review of #562: a bundle naming the contact mutual during the capture wins over the capture\'s result', async () => {
    const { verifyTransition } = await import('../../src/flows/verify')
    const capturing = { name: 'capturing', run: 3, card: null, mutual: [], preview: { role: 'sent', name: 'Bea', knownContact: null, self: false }, origin: 'camera' } as never
    const during = verifyTransition(capturing, { type: 'bundle', verifications: { 'c-bea': 'mutual' }, decisions: [] }).state
    const out = verifyTransition(during, { type: 'result', id: 'ver.capture', run: 3, result: { ok: true, value: { outcome: { kind: 'already-captured', contactId: 'c-bea' }, follow: 'counter-pending', decision: null, contactId: 'c-bea' } } } as never)
    expect(out).toMatchObject({ state: { name: 'success', contactId: 'c-bea', isNew: false }, row: 'capturing.result.bundle.mutual' })
    cover.mark(out.row!)
    // the stores already read mutual, the bundle not delivered yet: the result's own row
    const first = verifyTransition(capturing, { type: 'result', id: 'ver.capture', run: 3, result: { ok: true, value: { outcome: { kind: 'already-captured', contactId: 'c-bea' }, follow: 'mutual', decision: null, contactId: 'c-bea' } } } as never)
    expect(first).toMatchObject({ state: { name: 'success', isNew: false }, row: 'capturing.result.again.mutual' })
    cover.mark(first.row!)
  })

  it('review of #562, round 4: only a bundle during the act makes a refusal "gone"; the lage before the act does not', async () => {
    const A = await loopbackDevice({ carrier: memoryCarrier(), id: 'Al', name: 'Al', words: LOOPBACK_PHRASES[0], clock: virtualClock(T0, 'UTC'), seed: 181, ceremony: 'shared-connect' })
    // the connections of the bundle before the act do not name the ceremony's open request
    const connections = writableStore<Loadable<readonly Connection[]>>(ready([], revision(1, 1, 1)))
    const decisions = writableStore(A.port.stores.decisions.get())
    let answer: (r: Result<unknown>) => void = () => undefined
    const port: AppPort = { ...A.port, stores: { ...A.port.stores, decisions, connections }, trust: { ...A.port.trust, decide: () => ({ actId: 'x' as never, done: new Promise((r) => (answer = r)) as never }) } }
    const fb = flow(A, port)
    const shownCard = (await fb.until('ready')).card?.card ?? null
    decisions.set(ready([{ id: 'd1' as DecisionId, kind: 'connect-confirm', connection: 'e1' as ConnectionId, name: 'Bea', state: 'open', openedAt: 0, expiresAt: null, answers: { card: shownCard!, validUntil: Number.MAX_SAFE_INTEGER } }] as never, revision(99, 99, 99)))
    await fb.until('connectIncoming')
    fb.send({ type: 'accept' })
    answer({ ok: false, error: { kind: 'refused', code: 'not-possible-yet' } as never })
    await expect.poll(() => (fb.state() as { failed?: boolean }).failed).toBe(true)
    expect(fb.state()).toMatchObject({ name: 'connectIncoming', busy: null, failed: true })
    expect(fb.rows()).not.toContain('connectIncoming.result.gone')
  })

  it('review of #562: a capture waiting for its result offers back: the flow returns to the code', async () => {
    const A = await loopbackDevice({ carrier: memoryCarrier(), id: 'Al', name: 'Al', words: LOOPBACK_PHRASES[0], clock: virtualClock(T0, 'UTC'), seed: 171 })
    const port: AppPort = {
      ...A.port,
      trust: {
        ...A.port.trust,
        previewCard: async () => ({ ok: true, value: { role: 'sent', name: 'Bea', knownContact: null, self: false } }),
        confirmCard: () => ({ actId: 'x' as never, done: new Promise(() => undefined) as never }),
      },
    }
    const fa = flow(A, port)
    await fa.until('ready')
    fa.scanner.source = () => 'SENT-CARD'
    fa.send({ type: 'scan' })
    await fa.until('capturing')
    fa.send({ type: 'back' })
    await fa.until('ready')
    expect(fa.rows()).toContain('capturing.back')
  })

  it('no "keep waiting" on the back-code of a link without a relay: no carrier brings an acceptance there', async () => {
    const { devices } = await world(2)
    const [A] = devices as [LoopbackDevice]
    const connections = writableStore<Loadable<readonly Connection[]>>(ready([conn({ status: 'open', relayed: false })], revision(1, 2, 1)))
    const port: AppPort = {
      ...A.port,
      stores: { ...A.port.stores, connections },
      trust: {
        ...A.port.trust,
        previewCard: async () => ({ ok: true, value: { role: 'displayed', name: 'Bea', knownContact: null, self: false } }),
        confirmCard: () => ({ actId: 'x' as never, done: Promise.resolve({ ok: true, value: { kind: 'proposed', connection: 'e1', contactId: null } } as never) }),
        showBackCode: () => ({ actId: 'y' as never, done: Promise.resolve({ ok: true, value: { kind: 'shown', qr: 'BACK', validUntil: Number.MAX_SAFE_INTEGER } } as never) }),
      },
    }
    const fa = flow(A, port)
    await fa.until('ready')
    fa.scanner.source = () => 'https://web-of-trust.de/t#_from=x&_id=e1'
    fa.send({ type: 'scan' })
    await fa.until('confirm')
    fa.send({ type: 'yes' })
    await fa.until('backCode')
    fa.send({ type: 'keepWaiting' })
    expect(fa.state().name).toBe('backCode')
  })

  /** a lifecycle double that counts its listeners */
  const countingLifecycle = (base: LoopbackDevice['platform']['lifecycle'], state: { now: 'active' | 'background' }) => {
    const listeners = new Set<(s: 'active' | 'background') => void>()
    return { listeners, lifecycle: { ...base, current: () => state.now, onState: (cb: (s: 'active' | 'background') => void) => (listeners.add(cb), () => void listeners.delete(cb)) } }
  }
  /** a clock double that counts its pending timers */
  const countingClock = () => {
    const c = virtualClock(T0, 'UTC')
    const pending = new Set<object>()
    const clock = {
      ...c,
      now: () => c.now(),
      timeZone: () => c.timeZone(),
      setTimer: (at: number, cb: () => void) => {
        const token = {}
        pending.add(token)
        const off = c.setTimer(at, () => {
          pending.delete(token)
          cb()
        })
        return () => {
          pending.delete(token)
          off()
        }
      },
    }
    return { clock, pending, advance: (ms: number) => c.advance(ms) }
  }

  it('the back-code act waiting for the foreground lets go of the lifecycle when its run ends after the listener was set', async () => {
    const { devices } = await world(2)
    const [A] = devices as [LoopbackDevice]
    const { listeners, lifecycle } = countingLifecycle(A.platform.lifecycle, { now: 'background' })
    const exec = verifyExecutor(A.port, { ...A.platform, lifecycle }, { current: null })
    const run = new AbortController()
    const waiting = exec({ id: 'ver.back', run: 7, connection: 'e1' as ConnectionId }, run.signal)
    await new Promise((r) => setTimeout(r, 0))
    expect(listeners.size).toBe(1)
    run.abort()
    expect(await waiting).toEqual({ ok: false, code: 'cancelled' })
    expect(listeners.size).toBe(0)
  })

  it('a late back-code result after the run ended sets no listener at all', async () => {
    const { devices } = await world(2)
    const [A] = devices as [LoopbackDevice]
    const state = { now: 'active' as 'active' | 'background' }
    const { listeners, lifecycle } = countingLifecycle(A.platform.lifecycle, state)
    let release: (r: Result<BackShow>) => void = () => undefined
    const port: AppPort = { ...A.port, trust: { ...A.port.trust, showBackCode: () => ({ actId: 'y' as never, done: new Promise<Result<BackShow>>((r) => (release = r)) as never }) } }
    const exec = verifyExecutor(port, { ...A.platform, lifecycle }, { current: null })
    const run = new AbortController()
    const waiting = exec({ id: 'ver.back', run: 7, connection: 'e1' as ConnectionId }, run.signal)
    // the app goes behind and the run ends while the act is out; then the act answers "background"
    state.now = 'background'
    run.abort()
    release({ ok: true, value: { kind: 'not-shown', why: 'background' } })
    expect(await waiting).toEqual({ ok: false, code: 'cancelled' })
    expect(listeners.size).toBe(0)
  })

  it('a wait of the flow ends with its run: its timer is removed, and none is set for a run already ended', async () => {
    const { devices } = await world(2)
    const [A] = devices as [LoopbackDevice]
    const { clock, pending, advance } = countingClock()
    const exec = verifyExecutor(A.port, { ...A.platform, clock: clock as never }, { current: null })
    const run = new AbortController()
    const waiting = exec({ id: 'ver.wait', run: 3, ms: 12_000 }, run.signal)
    expect(pending.size).toBe(1)
    run.abort()
    expect(await waiting).toEqual({ ok: false, code: 'cancelled' })
    expect(pending.size).toBe(0)
    expect(await exec({ id: 'ver.expire', run: 4, at: T0 + 5000 }, run.signal)).toEqual({ ok: false, code: 'cancelled' })
    expect(pending.size).toBe(0)
    const live = new AbortController()
    const fires = exec({ id: 'ver.wait', run: 5, ms: 1000 }, live.signal)
    advance(1000)
    expect(await fires).toEqual({ ok: true })
    expect(pending.size).toBe(0)
  })

  it('over a port double: the shower judges the read against its ceremony as the newest bundle has it', async () => {
    const { devices } = await world(2)
    const [A] = devices as [LoopbackDevice]
    const cases: [BackRead, Partial<Connection> & Pick<Connection, 'status'>, VerifyState['name'], string][] = [
      [{ kind: 'taken', connection: 'e1' as ConnectionId }, { status: 'open', role: 'inviter', decision: 'd1' as DecisionId }, 'connectIncoming', 'readingBack.result.proposed'],
      [{ kind: 'again', connection: 'e1' as ConnectionId }, { status: 'open', role: 'inviter', accepted: true, contactId: 'c-bea' as ContactId }, 'success', 'readingBack.result.contact'],
      // W3: the confirmation the read opened was closed meanwhile (declined): nothing to ask
      [{ kind: 'taken', connection: 'e1' as ConnectionId }, { status: 'declined', role: 'inviter' }, 'ready', 'readingBack.result.ok'],
      [{ kind: 'refused', connection: 'e1' as ConnectionId, reason: 'second-propose' }, { status: 'open', role: 'inviter' }, 'scanError', 'readingBack.result.refused'],
      [{ kind: 'expired', connection: 'e1' as ConnectionId }, { status: 'open', role: 'inviter' }, 'scanError', 'readingBack.result.refused'],
      [{ kind: 'no-match' }, { status: 'open', role: 'inviter' }, 'scanError', 'readingBack.result.refused'],
      // ended with an error after the acceptance opened the contact: the error, the contact stays
      [{ kind: 'again', connection: 'e1' as ConnectionId }, { status: 'failed', role: 'inviter', accepted: true, contactId: 'c-bea' as ContactId }, 'scanError', 'readingBack.result.failed'],
    ]
    for (const [i, [read, state, to, rowId]] of cases.entries()) {
      let release: () => void = () => undefined
      const held = new Promise<void>((r) => (release = r))
      const connections = writableStore<Loadable<readonly Connection[]>>(ready([], revision(1, 1, 1)))
      const decisions = writableStore(A.port.stores.decisions.get())
      const port: AppPort = {
        ...A.port,
        stores: { ...A.port.stores, decisions, connections },
        trust: { ...A.port.trust, previewCard: async () => ({ ok: true, value: { role: 'back', name: 'Bea', knownContact: null, self: false } }), readBackCode: async () => (await held, { ok: true, value: read }) },
      }
      const fb = flow(A, port)
      const shownCard = (await fb.until('ready')).card?.card ?? null
      fb.scanner.source = () => 'BACK'
      fb.send({ type: 'scan' })
      await fb.until('readingBack')
      if (i === 0) {
        // the shown code gets another proposal meanwhile: not taken, the read's own ceremony is asked
        decisions.set(ready([{ id: 'd2' as DecisionId, kind: 'connect-confirm', connection: 'e2' as ConnectionId, name: 'Ali', state: 'open', openedAt: 0, expiresAt: null, answers: { card: shownCard!, validUntil: Number.MAX_SAFE_INTEGER } }] as never, revision(1, 9, 1)))
        await new Promise((r) => setTimeout(r, 0))
        expect(fb.state().name).toBe('readingBack')
      }
      connections.set(ready([conn(state)], revision(1, 3, 1)))
      release()
      await fb.until(to)
      if (i === 0) expect(fb.state()).toMatchObject({ connection: 'e1', decision: 'd1', name2: 'Bea' })
      if (i === 3 || i === 5) expect(fb.state()).toMatchObject({ code: 'card-invalid' })
      if (i === 4) expect(fb.state()).toMatchObject({ code: 'code-expired' })
      expect(fb.rows()).toContain(rowId)
    }
  })

  it('a responder whose link names no relay (the inviter has no carrier): the back-code at once, also online; the inviter reads it and both have a contact', async () => {
    const med = mediatorDouble()
    const clock = virtualClock(Date.now(), 'UTC')
    // A: no mediator (a carrier that takes documents, no shared-connect wires); B: the mediator, online
    const A = await loopbackDevice({ carrier: memoryCarrier(), id: 'Al', name: 'Al', words: LOOPBACK_PHRASES[0], clock, seed: 121, ceremony: 'shared-connect' })
    const B = await loopbackDevice({ carrier: { mediator: med }, id: 'Bea', name: 'Bea', words: LOOPBACK_PHRASES[1], clock, seed: 128, ceremony: 'shared-connect' })
    const settle = async () => {
      for (let i = 0; i < 40; i++) {
        await med.settled()
        for (const d of [A, B]) await d.port.session()?.idle()
        await new Promise((r) => setTimeout(r, 0))
      }
    }
    await settle()
    // the responder's carrier is in reach: the code at once comes from the missing relay, not from the carrier
    expect(carrierInReach(B.port)).toBe(true)
    const fa = flow(A)
    const fb = flow(B)
    await fa.until('ready')
    const link = fa.state().card?.qr ?? ''
    await fb.until('ready')
    fb.scanner.source = () => link
    fb.send({ type: 'scan' })
    await fb.until('confirm')
    fb.send({ type: 'yes' })
    const back = (await fb.until('backCode')) as Extract<VerifyState, { name: 'backCode' }>
    expect(fb.rows()).toContain('scanner.back')
    // the link of a device without a carrier names no relay: the projection says so
    expect((B.port.stores.connections.get() as { value?: Connection[] }).value?.find((c) => c.role === 'responder')).toMatchObject({ relayed: false, camera: true })
    fa.scanner.source = () => back.qr
    fa.send({ type: 'scan' })
    await fa.until('connectIncoming')
    fa.send({ type: 'accept' })
    await fa.until('success')
    await settle()
    for (const d of [A, B]) expect((d.port.stores.contacts.get() as { value?: unknown[] }).value).toHaveLength(1)
  }, 60_000)
})
