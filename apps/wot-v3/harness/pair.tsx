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
//
// Everything lives in the page's realm; a phone frame takes its composition from window.parent.

import { useState, useSyncExternalStore } from 'react'
import type { Composition, HarnessPage } from '../src/app/compose'
import { writableStore, type ReadStore } from '../src/port'
import { virtualClock, type FakeMail, type FakeScanner, type VirtualClock } from '../src/platform/fake'
import { LOOPBACK_PHRASES, loopbackDevice, memoryCarrier, type LoopbackDevice, type MemoryCarrier } from './loopback'

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
  readonly carrier: MemoryCarrier
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

/** The two phones meet and write, through real acts only (architecture §3.3: no seeded state). */
async function seedConversation(carrier: MemoryCarrier, clock: VirtualClock, jonas: LoopbackDevice, noah: LoopbackDevice, block: boolean): Promise<void> {
  const settle = async () => {
    for (let i = 0; i < 5; i++) {
      await carrier.settled()
      await jonas.port.session()?.idle()
      await noah.port.session()?.idle()
    }
  }
  const shown = await noah.port.trust.showCard().done
  if (!shown.ok) throw new Error('harness: show')
  const scanned = await jonas.port.trust.confirmCard(shown.value.qr).done
  if (!scanned.ok) throw new Error('harness: scan')
  await settle()
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

async function createWorld(lang: 'en' | 'de', theme: PairWorld['theme'], met: boolean, block: boolean): Promise<PairWorld> {
  const carrier = memoryCarrier()
  const clock = virtualClock(START, TZ)
  const optics = new Map<string, string>()
  const devices = new Map<string, LoopbackDevice>()
  let seed = 101
  for (const [i, p] of PAIR_PHONES.entries()) {
    const d = await loopbackDevice({ carrier, id: p.id, name: p.name, words: LOOPBACK_PHRASES[i] ?? LOOPBACK_PHRASES[0], clock, seed: (seed += 17), language: lang })
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
  }
  if (met) {
    const [jonas, noah] = PAIR_PHONES.map((p) => devices.get(p.id))
    if (jonas && noah) await seedConversation(carrier, clock, jonas, noah, block)
    optics.clear()
  }
  const online = writableStore<Readonly<Record<string, boolean>>>(Object.fromEntries(PAIR_PHONES.map((p) => [p.id, true])))
  return {
    carrier,
    clock,
    devices,
    optics,
    theme,
    online: {
      ...online,
      set(v) {
        for (const [id, on] of Object.entries(v)) carrier.setOnline(id, on)
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
    return phoneComposition(world, phone)
  }
  const lang = p.get('lang') === 'de' ? 'de' : 'en'
  const theme = p.get('theme') === 'dark' ? 'dark' : p.get('theme') === 'light' ? 'light' : 'system'
  const scenario = p.get('scenario')
  const world = createWorld(lang, theme, scenario === CONVERSATION_PAIR || scenario === BLOCKED_PAIR, scenario === BLOCKED_PAIR)
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
        <strong>Harness · two phones meet (loopback, real library)</strong>
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
