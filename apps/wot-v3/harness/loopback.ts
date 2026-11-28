// Loopback devices (architecture §3.3): the real adapter on the real library, each device with its
// own fake platform (vault, keystore, prefs), its own in-memory IndexedDB (fake-indexeddb, so every
// page load starts clean) and one endpoint on a shared in-memory carrier. Identities are set up
// through the real port steps with public test phrases; states come only from real holder acts.

import { IDBFactory } from 'fake-indexeddb'
import { createRltpPort, mediatorTransport, memoryCarrier, type MediatorCarrier, type MemoryCarrier, type RltpFaults, type RltpPort } from '../src/adapters/rltp'
import type { WireConfig } from '../src/adapters/rltp/wire'
import type { DeviceTimers } from '../src/adapters/rltp/transport'
import type { ContactId, IdentityNs, Mnemonic, Secret } from '../src/port'
import { secret } from '../src/port'
import { createFakePlatform, fakeDevice, fakeEntropy, fakeIdentityPlatform, type FakeDevice, type VirtualClock } from '../src/platform/fake'
import type { Language } from '../src/platform/ports'
import { webDatabases } from '../src/platform/web/identity'

/** Public BIP-39 test phrases (vectors), one per loopback person. Never real secrets. */
export const LOOPBACK_PHRASES = [
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about',
  'legal winner thank year wave sausage worth useful legal winner thank yellow',
  'letter advice cage absurd amount doctor acoustic avoid letter advice cage above',
  'zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo wrong',
  'jelly better achieve collect unaware mountain thought cargo oxygen act hood bridge',
] as const

export const LOOPBACK_PASSPHRASE = 'harness passphrase'

export interface LoopbackDevice {
  readonly id: string
  readonly port: RltpPort
  readonly platform: ReturnType<typeof createFakePlatform>
  readonly device: FakeDevice
  readonly faults: RltpFaults
}

export { memoryCarrier, type MemoryCarrier }

/** how much device time the harness drives a refusal that persists before it waits for the next move
 *  of the clock (a button, a written message) */
export const DRIVE_LIMIT_MS = 60_000

/** The carrier's timers on the phones' virtual clock, driven by the harness (#430): when the carrier
 *  plans a redelivery, the harness moves the clock to its due time after a zero-delay yield of the event
 *  loop (turns, not time), so nothing waits real time and the phones see the time that passed. A
 *  refusal that persists (rate limit, a failing store) is driven for at most `limit` of device time in
 *  a row; the next move of the clock by anyone else starts a new stretch, and the timer stays planned.
 *  The budget is the carrier's, not an endpoint's: the harness has one carrier and two phones, and a
 *  stretch moves both phones' clocks (their own timers fire as in real device time). */
export function drivenTimers(clock: VirtualClock, limit = DRIVE_LIMIT_MS): DeviceTimers {
  let driven = 0
  let last: number | null = null
  return {
    now: () => clock.now(),
    setTimer(at, fn) {
      let live = true
      const cancel = clock.setTimer(at, () => {
        live = false
        fn()
      })
      setTimeout(() => {
        if (!live) return
        if (last !== clock.now()) driven = 0
        const step = Math.max(0, at - clock.now())
        if (driven + step > limit) return
        driven += step
        clock.advance(step)
        last = clock.now()
      }, 0)
      return () => {
        live = false
        cancel()
      }
    },
  }
}

export async function loopbackDevice(opts: {
  /** the in-memory carrier, or the VTI mediator C (the real wire) over the mediator double's network
   *  (`net`, harness/mediator-double.ts) or the real one */
  carrier: MemoryCarrier | { readonly mediator: { readonly did: string; readonly net?: WireConfig['net'] }; readonly timers?: DeviceTimers }
  id: string
  name: string
  words: string
  clock: VirtualClock
  seed: number
  language?: Language
  /** tests: the app's foreground and background, as the session sees it */
  lifecycle?: { onState(cb: (s: 'active' | 'background') => void): () => void; current?(): 'active' | 'background' }
  wrap?: (t: ReturnType<MemoryCarrier['endpoint']> | MediatorCarrier) => ReturnType<MemoryCarrier['endpoint']> | MediatorCarrier
}): Promise<LoopbackDevice> {
  const device = fakeDevice()
  const entropy = fakeEntropy(opts.seed)
  const platform = createFakePlatform({ clock: opts.clock, device, seed: opts.seed + 1, ...(opts.language ? { language: opts.language } : {}) })
  // the wipe deletes and verifies the databases the adapter really writes (review 420 R8-3)
  const idb = new IDBFactory()
  const identity = fakeIdentityPlatform(device, { clock: opts.clock, entropy, databases: webDatabases(idb) })
  const faults: RltpFaults = { killAt: null }
  const carrier = opts.carrier
  const made: ReturnType<MemoryCarrier['endpoint']> | MediatorCarrier =
    'mediator' in carrier
      ? mediatorTransport({ did: carrier.mediator.did, clock: carrier.timers ?? opts.clock, network: platform.network, ...(carrier.mediator.net ? { net: carrier.mediator.net } : {}) })
      : carrier.endpoint(opts.id)
  const transport = opts.wrap ? opts.wrap(made) : made
  const port = createRltpPort({
    faults,
    ...(opts.lifecycle ? { lifecycle: opts.lifecycle } : {}),
    identity,
    idb,
    transport,
    // two phones in one page: each device has its own writer
    writer: { acquire: async () => () => undefined },
  })
  const rt = port.runtime
  await rt.boot()
  const r = await rt.setup.reserve('setup', 'passphrase')
  if (!r.ok) throw new Error('loopback: reserve')
  const ns: IdentityNs = r.value.ns
  const w = await rt.setup.writeVault(ns, {
    mnemonic: secret(opts.words.split(' ')) as unknown as Secret<Mnemonic>,
    protection: { mode: 'passphrase', passphrase: secret(LOOPBACK_PASSPHRASE) },
    profile: { name: opts.name },
    termsVersion: rt.termsConsent().current,
  })
  if (!w.ok) throw new Error('loopback: vault')
  const i = await rt.setup.initHolder(ns)
  if (!i.ok) throw new Error('loopback: init')
  const a = await rt.setup.activate(ns)
  if (!a.ok) throw new Error('loopback: activate')
  return { id: opts.id, port, platform, device, faults }
}

/** Two phones meet in the connection ceremony (shared-connect), the app's one ceremony: B shows its code, A
 *  reads it with its camera and proposes, B accepts the proposal. Over a carrier the proposal reaches B
 *  through it; without one (the in-memory carrier carries no ceremony) A shows its back-code and B's camera
 *  reads it. Returns each phone's id of the other, once both have the contact. */
export async function meet(A: LoopbackDevice, B: LoopbackDevice, settle: () => Promise<void>): Promise<{ bAtA: ContactId; aAtB: ContactId }> {
  const shown = await B.port.trust.showCard().done
  if (!shown.ok) throw new Error('harness: show')
  await settle()
  const proposed = await A.port.trust.confirmCard(shown.value.qr, 'camera').done
  if (!proposed.ok || proposed.value.kind !== 'proposed') throw new Error('harness: propose')
  const connection = proposed.value.connection
  await settle()
  const proposal = () => {
    const decisions = B.port.stores.decisions.get()
    return decisions.status === 'ready' ? decisions.value.find((d) => d.kind === 'connect-confirm' && d.state === 'open') : undefined
  }
  if (!proposal()) {
    // no carrier brought the proposal: the back-code, read by B's camera
    const back = await A.port.trust.showBackCode(connection).done
    if (!back.ok || back.value.kind !== 'shown') throw new Error('harness: back-code')
    const read = await B.port.trust.readBackCode(back.value.qr)
    if (!read.ok || read.value.kind !== 'taken') throw new Error('harness: read back-code')
    await settle()
  }
  const open = proposal()
  if (!open) throw new Error('harness: no proposal at the shower')
  const accepted = await B.port.trust.decide(open.id, 'accept').done
  if (!accepted.ok) throw new Error('harness: accept')
  await settle()
  const contactOf = (d: LoopbackDevice, id: string): ContactId => {
    const c = d.port.stores.connections.get()
    const contactId = c.status === 'ready' ? c.value.find((x) => x.id === id)?.contactId : null
    if (!contactId) throw new Error(`harness: the ceremony gave no contact at ${d.id}`)
    return contactId
  }
  return { bAtA: contactOf(A, connection), aAtB: contactOf(B, shown.value.card ?? connection) }
}
