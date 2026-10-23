// Harness scenario "two phones meet" (architecture §3.3, §7.3): two loopback devices on the real
// adapter and the real library, one in-memory carrier, one virtual clock. The page shows both phones
// as iframes (each its own viewport, so the phone layout is the real one); the phones' fake cameras
// see the code the other phone shows last (QR round trip as data). Controls: each phone online or
// offline, the clock forward.
//
//   ?scenario=encounter                 the page with both phones, not met yet
//   ?scenario=conversation              the same after a real encounter and a few real messages
//   ?scenario=blocked                   the conversation, then Noah blocks Jonas (a real block act):
//                                       what Jonas writes is acknowledged and shown nowhere at Noah
//   ?scenario=…&phone=<id>              one phone (loaded by the page's iframes)
//   &carrier=mediator                   the phones carry through the VTI mediator (the real wire and the
//                                       library's adapter) over the mediator double in the page
//   &carrier=live[&mediator=<did>]      the same over the real network, the dev instance by default
//                                       (TRANSPORT.md "The VTI mediator"; e2e/live-mediator.spec.ts)
//
// Everything lives in the page's realm; a phone frame takes its composition from window.parent.

import { useState, useSyncExternalStore } from 'react'
import type { Composition, HarnessPage } from '../src/app/compose'
import { writableStore, type ReadStore } from '../src/port'
import { virtualClock, type FakeMail, type FakeScanner, type VirtualClock } from '../src/platform/fake'
import { drivenTimers, LOOPBACK_PHRASES, loopbackDevice, memoryCarrier, type LoopbackDevice, type MemoryCarrier } from './loopback'
import { exposeDevice } from './device'
import { mediatorDouble, phoneNet, type MediatorDouble } from './mediator-double'

/** the VTI dev instance (trust-protocol binding/README.md "Instanz"), the default of `carrier=live` */
export const DEV_MEDIATOR_DID = 'did:webvh:QmR5xGk8pkd3ymu7xpfkjr7XZmwDALA5ZJmgG7qcrD2mKA:webvh.storm.ws:mediator'

/** how the phones are carried: the in-memory carrier, the VTI mediator over the double, or live */
export type PairCarrier = { readonly kind: 'memory' } | { readonly kind: 'mediator' } | { readonly kind: 'live'; readonly did: string }

export const PAIR_PHONES = [
  { id: 'jonas', name: 'Jonas Weber' },
  { id: 'noah', name: 'Noah Lindqvist' },
] as const

export const ENCOUNTER_PAIR = 'encounter'
export const CONVERSATION_PAIR = 'conversation'
export const BLOCKED_PAIR = 'blocked'

const START = Date.parse('2026-10-15T13:30:00-07:00')
const TZ = 'America/Los_Angeles'

interface PairWorld {
  readonly clock: VirtualClock
  readonly devices: ReadonlyMap<string, LoopbackDevice>
  /** the code each phone shows last (its displayed card or its sent card) */
  readonly optics: Map<string, string>
  readonly online: ReadStore<Readonly<Record<string, boolean>>> & { set(v: Readonly<Record<string, boolean>>): void }
  readonly theme: 'light' | 'dark' | 'system'
}

declare global {
  interface Window {
    __wotPair?: Promise<PairWorld>
  }
}

/** until the phones rest: the carrier's turns, the sessions, the mediator instances' work */
function settler(jonas: LoopbackDevice, noah: LoopbackDevice, carrier: MemoryCarrier | null, med: MediatorDouble | null) {
  return async () => {
    for (let calm = 0, i = 0; calm < 2 && i < 400; i++) {
      await carrier?.settled()
      await med?.settled()
      await jonas.port.session()?.idle()
      await noah.port.session()?.idle()
      await new Promise((r) => setTimeout(r, 0))
      calm = (jonas.port.session()?.transportBusy() ?? 0) + (noah.port.session()?.transportBusy() ?? 0) === 0 ? calm + 1 : 0
    }
  }
}

/** The two phones meet and write, through real acts only (architecture §3.3: no seeded state). Over the
 *  mediator Noah learns Jonas's delivery hint from Jonas's sent card (the optical leg): the bundle waits
 *  at the mediator until then (TRANSPORT.md "The VTI mediator"). */
async function seedConversation(settle: () => Promise<void>, optical: boolean, clock: VirtualClock, jonas: LoopbackDevice, noah: LoopbackDevice, block: boolean): Promise<void> {
  const shown = await noah.port.trust.showCard().done
  if (!shown.ok) throw new Error('harness: show')
  const scanned = await jonas.port.trust.confirmCard(shown.value.qr).done
  if (!scanned.ok) throw new Error('harness: scan')
  await settle()
  if (optical && scanned.value.contactId) {
    const sent = await jonas.port.trust.sentCardFor(scanned.value.contactId)
    if (!sent.ok) throw new Error('harness: sent card')
    const captured = await noah.port.trust.confirmCard(sent.value.qr).done
    if (!captured.ok) throw new Error('harness: capture')
    await settle()
  }
  const decisions = noah.port.stores.decisions.get()
  const open = decisions.status === 'ready' ? decisions.value.find((d) => d.kind === 'encounter-confirm') : undefined
  if (!open || open.kind !== 'encounter-confirm') throw new Error('harness: no confirmation at noah')
  await noah.port.trust.counterVerify(open.contactId).done
  await settle()
  const noahAtJonas = scanned.value.contactId
  const jonasAtNoah = open.contactId
  if (!noahAtJonas) throw new Error('harness: no contact at jonas')
  clock.advance(4 * 60_000)
  await jonas.port.trust.send(`c:${noahAtJonas}`, 'Great to meet you at the session on offline verification!', 'seed-1').done
  await settle()
  clock.advance(3 * 60_000)
  await noah.port.trust.send(`c:${jonasAtNoah}`, 'Likewise. Coffee at the next break?', 'seed-2').done
  await settle()
  clock.advance(60_000)
  await jonas.port.trust.send(`c:${noahAtJonas}`, 'Yes, see you at the stall.', 'seed-3').done
  await settle()
  if (block) {
    clock.advance(60_000)
    const b = await noah.port.trust.block({ kind: 'contact', contactId: jonasAtNoah }).done
    if (!b.ok) throw new Error('harness: block')
    await settle()
  }
}

async function createWorld(lang: 'en' | 'de', theme: PairWorld['theme'], met: boolean, block: boolean, camera: FakeScanner['camera'] = 'ok', how: PairCarrier = { kind: 'memory' }): Promise<PairWorld> {
  // live: the mediator issues tokens on its own clock, so the phones' clock starts at the real time
  const clock = virtualClock(how.kind === 'live' ? Date.now() : START, TZ)
  // the carrier's redelivery runs on the phones' clock, and the harness drives it (#430): a transiently
  // refused document comes again at its due time, never on real time
  const carrier = how.kind === 'memory' ? memoryCarrier(drivenTimers(clock)) : null
  const med = how.kind === 'mediator' ? mediatorDouble(undefined, () => clock.now()) : null
  const did = how.kind === 'live' ? how.did : (med?.did ?? '')
  const switches = new Map<string, (on: boolean) => void>()
  const optics = new Map<string, string>()
  const devices = new Map<string, LoopbackDevice>()
  let seed = 101
  for (const [i, p] of PAIR_PHONES.entries()) {
    // over the mediator each phone has its own network below the wire, switched by "online"
    const pn = carrier ? null : phoneNet(med?.net ?? {})
    const d = await loopbackDevice({
      carrier: carrier ?? { mediator: { did, ...(pn ? { net: pn.net } : {}) } },
      id: p.id,
      name: p.name,
      words: LOOPBACK_PHRASES[i] ?? LOOPBACK_PHRASES[0],
      clock,
      seed: (seed += 17),
      language: lang,
    })
    switches.set(p.id, (on) => {
      if (carrier) return carrier.setOnline(p.id, on)
      pn?.setOnline(on)
      d.platform.network.set(on ? 'online' : 'offline')
    })
    // record what this phone shows: the displayed card and the sent card of the optical return path
    const trust = d.port.trust
    const showCard = trust.showCard.bind(trust)
    const sentCardFor = trust.sentCardFor.bind(trust)
    const send = trust.send.bind(trust)
    Object.assign(trust, {
      // the virtual clock stands still between button presses; every message takes a second, so
      // messages written in the harness keep the order they were written in (display time, 4430)
      send: (...args: Parameters<typeof send>) => {
        clock.advance(1000)
        return send(...args)
      },
      showCard: () => {
        const h = showCard()
        void h.done.then((r) => (r.ok ? optics.set(p.id, r.value.qr) : undefined))
        return h
      },
      sentCardFor: async (contactId: Parameters<typeof sentCardFor>[0]) => {
        const r = await sentCardFor(contactId)
        if (r.ok) optics.set(p.id, r.value.qr)
        return r
      },
    })
    devices.set(p.id, d)
  }
  for (const p of PAIR_PHONES) {
    const other = PAIR_PHONES.find((x) => x.id !== p.id)
    const scanner = devices.get(p.id)?.platform.scanner as FakeScanner | undefined
    if (scanner && other) scanner.source = () => optics.get(other.id) ?? null
    // the camera of every phone (URL `camera`, e2e/platform.spec.ts)
    if (scanner) scanner.camera = camera
  }
  if (met) {
    const [jonas, noah] = PAIR_PHONES.map((p) => devices.get(p.id))
    if (jonas && noah) await seedConversation(settler(jonas, noah, carrier, med), how.kind !== 'memory', clock, jonas, noah, block)
    optics.clear()
  }
  const online = writableStore<Readonly<Record<string, boolean>>>(Object.fromEntries(PAIR_PHONES.map((p) => [p.id, true])))
  return {
    clock,
    devices,
    optics,
    theme,
    online: {
      ...online,
      set(v) {
        for (const [id, on] of Object.entries(v)) switches.get(id)?.(on)
        online.set(v)
      },
    },
  }
}

function phoneComposition(world: PairWorld, id: string): Composition {
  const d = world.devices.get(id)
  if (!d) throw new Error(`harness: no phone ${id}`)
  return { port: d.port, platform: d.platform, theme: world.theme }
}

export async function bootPair(url: URL): Promise<Composition | HarnessPage> {
  const p = url.searchParams
  const phone = p.get('phone')
  if (phone) {
    const world = await window.parent.__wotPair
    if (!world) throw new Error('harness: the phone frame needs the pair page')
    const d = world.devices.get(phone)
    if (d) exposeDevice(d.platform, world.clock)
    return phoneComposition(world, phone)
  }
  const lang = p.get('lang') === 'de' ? 'de' : 'en'
  const theme = p.get('theme') === 'dark' ? 'dark' : p.get('theme') === 'light' ? 'light' : 'system'
  const scenario = p.get('scenario')
  const camera = (['ok', 'denied', 'unavailable', 'prompt'] as const).find((c) => c === p.get('camera')) ?? 'ok'
  const how: PairCarrier = p.get('carrier') === 'mediator' ? { kind: 'mediator' } : p.get('carrier') === 'live' ? { kind: 'live', did: p.get('mediator') ?? DEV_MEDIATOR_DID } : { kind: 'memory' }
  const world = createWorld(lang, theme, scenario === CONVERSATION_PAIR || scenario === BLOCKED_PAIR, scenario === BLOCKED_PAIR, camera, how)
  window.__wotPair = world
  const ready = await world
  if (theme !== 'system') document.documentElement.setAttribute('data-theme', theme)
  return { Root: () => <PairPage world={ready} query={url.search} /> }
}

function setMailApp(world: PairWorld, id: string, available: boolean) {
  const mail = world.devices.get(id)?.platform.mail as FakeMail | undefined
  if (mail) mail.available = available
}

/** the phone's mail app (FakeMail): off shows the copy fallback of a report */
function MailToggle({ world, id, name }: { world: PairWorld; id: string; name: string }) {
  const mail = world.devices.get(id)?.platform.mail as FakeMail | undefined
  const [on, setOn] = useState(mail?.available ?? true)
  return (
    <label className="flex items-center gap-2">
      <input
        type="checkbox"
        checked={on}
        onChange={(e) => {
          setMailApp(world, id, e.target.checked)
          setOn(e.target.checked)
        }}
      />
      {name} has a mail app
    </label>
  )
}

function PairPage({ world, query }: { world: PairWorld; query: string }) {
  const online = useSyncExternalStore(world.online.subscribe, world.online.get)
  const [now, setNow] = useState(world.clock.now())
  const advance = (ms: number) => {
    world.clock.advance(ms)
    setNow(world.clock.now())
  }
  const src = (id: string) => {
    const q = new URLSearchParams(query)
    q.set('phone', id)
    return `?${q.toString()}`
  }
  return (
    <main className="flex min-h-0 flex-1 flex-col gap-3 overflow-auto bg-muted p-4 text-foreground">
      <div className="flex flex-wrap items-center gap-3 text-sm">
        <strong>Harness · two phones meet (loopback, real library{query.includes('carrier=mediator') ? ', VTI mediator double' : query.includes('carrier=live') ? ', VTI mediator live' : ''})</strong>
        <span className="font-mono text-xs text-muted-foreground">{new Date(now).toISOString()}</span>
        <button type="button" className="rounded-md border border-border bg-background px-2 py-1" onClick={() => advance(60_000)}>
          +1 min
        </button>
        <button type="button" className="rounded-md border border-border bg-background px-2 py-1" onClick={() => advance(5 * 60_000)}>
          +5 min
        </button>
      </div>
      <div className="flex flex-wrap items-start gap-6">
        {PAIR_PHONES.map((p) => (
          <div key={p.id} className="flex flex-col gap-2">
            <div className="flex flex-wrap items-center gap-4 text-sm">
              <label className="flex items-center gap-2">
                <input type="checkbox" checked={online[p.id] ?? true} onChange={(e) => world.online.set({ ...online, [p.id]: e.target.checked })} />
                {p.name} online
              </label>
              <MailToggle world={world} id={p.id} name={p.name} />
            </div>
            <iframe
              title={p.name}
              name={p.id}
              src={src(p.id)}
              width={390}
              height={844}
              className="rounded-[24px] border border-border bg-background shadow-lg"
            />
          </div>
        ))}
      </div>
    </main>
  )
}
