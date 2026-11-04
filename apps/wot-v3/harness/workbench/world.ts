// The workbench world (architecture §7.4): up to five loopback devices, each the real adapter on the
// real library with its own fake platform, on one carrier (the in-memory carrier, the VTI mediator
// double in the page, or a live TSP 1.0 mediator) and one virtual clock. Everything the page shows is
// read from the devices' port stores; every act is a real act on a device's port. The world lives in
// the page's realm; each phone frame takes its composition from window.parent (as pair.tsx).

import type { Composition } from '../../src/app/compose'
import { writableStore, type ContactListItem, type Loadable, type ReadStore } from '../../src/port'
import type { CarrierEvent } from '../../src/adapters/rltp/transport'
import type { FakeScanner, VirtualClock } from '../../src/platform/fake'
import { virtualClock } from '../../src/platform/fake'
import { drivenTimers, LOOPBACK_PHRASES, loopbackDevice, memoryCarrier, type LoopbackDevice, type MemoryCarrier } from '../loopback'
import { mediatorDouble, phoneNet, type MediatorDouble } from '../mediator-double'
import { edgesOf, type DeviceContacts, type Edge } from './graph'

export interface WorkbenchPerson {
  readonly id: string
  readonly name: string
  readonly color: string
}

/** the people the workbench can seat, in order; a phone opens for each seated one */
export const PEOPLE: readonly WorkbenchPerson[] = [
  { id: 'jonas', name: 'Jonas Weber', color: '#3b82f6' },
  { id: 'noah', name: 'Noah Lindqvist', color: '#ef4444' },
  { id: 'lea', name: 'Lea Brandt', color: '#f59e0b' },
  { id: 'mara', name: 'Mara Kowalski', color: '#ec4899' },
  { id: 'sam', name: 'Sam Okafor', color: '#84cc16' },
]

export type WorkbenchCarrier = { readonly kind: 'memory' } | { readonly kind: 'mediator' } | { readonly kind: 'live'; readonly did: string; readonly insecure?: boolean }

/** One entry of the wire list: a document and what became of it at each endpoint it was offered to. */
export interface WireEntry {
  readonly n: number
  readonly digest: string
  readonly from: string
  /** short task type: the last two path segments */
  readonly type: string
  readonly threadId: string
  readonly attempt: number
  /** virtual time of the submission */
  readonly at: number
  /** the endpoint that took it, once one did */
  readonly to: string | null
  readonly disposition: 'in flight' | 'taken' | 'refused for now' | 'nobody'
}

/** The ceremony as the stage sees it: a phone whose camera is open (`scanning`), the phone whose code
 *  it is pointed at (`showing`: the room's newest card that is not its own), and the lens. The camera
 *  sees the code only once the lens is open (`land()`): the page opens it when the scanning phone has
 *  flown over the showing one, so the scan happens where the eye sees it happen. */
export interface CeremonyState {
  readonly scanning: string | null
  readonly showing: string | null
  readonly lens: boolean
}

export interface WorkbenchWorld {
  readonly carrier: WorkbenchCarrier
  readonly clock: VirtualClock
  readonly people: readonly WorkbenchPerson[]
  readonly devices: ReadonlyMap<string, LoopbackDevice>
  readonly theme: 'light' | 'dark' | 'system'
  readonly online: ReadStore<Readonly<Record<string, boolean>>> & { set(v: Readonly<Record<string, boolean>>): void }
  /** the wire, newest first; empty and `observable: false` over a carrier the page cannot watch */
  readonly wire: ReadStore<readonly WireEntry[]>
  readonly wireObservable: boolean
  /** the graph's edges, from the devices' contact lists; `rev` bumps on every change */
  readonly graph: ReadStore<{ readonly edges: readonly Edge[]; readonly rev: number }>
  readonly ceremony: ReadStore<CeremonyState> & {
    /** the scanning phone has arrived over the code: its camera may see it now */
    land(): void
  }
  /** until the devices rest */
  settle(): Promise<void>
  /** god mode: the two meet, both ways (a real ceremony on both ports; optical leg over the mediator) */
  meet(a: string, b: string): Promise<void>
}

const START = Date.parse('2026-11-05T14:30:00-08:00')
const TZ = 'America/Los_Angeles'

const shortType = (type: string) => type.split('/').slice(-2).join('/')

declare global {
  interface Window {
    __wotWorkbench?: Promise<WorkbenchWorld>
  }
}

function contactsOf(d: LoopbackDevice): readonly ContactListItem[] {
  const v: Loadable<readonly ContactListItem[]> = d.port.stores.contacts.get()
  return v.status === 'ready' ? v.value : []
}

export async function createWorkbenchWorld(opts: {
  people: readonly WorkbenchPerson[]
  carrier: WorkbenchCarrier
  lang: 'en' | 'de'
  theme: WorkbenchWorld['theme']
  tz?: string
  /** pairs that met before the page opened */
  met: readonly (readonly [string, string])[]
}): Promise<WorkbenchWorld> {
  const how = opts.carrier
  const tz = opts.tz ?? TZ
  // live: the mediator issues tokens on its own clock, so the phones' clock starts at the real time
  // and follows it (never back); the harness clock otherwise runs only when moved
  const clock = virtualClock(how.kind === 'live' ? Date.now() : START, tz)
  if (how.kind === 'live') setInterval(() => clock.set(Math.max(clock.now(), Date.now())), 1000)
  const carrier: MemoryCarrier | null = how.kind === 'memory' ? memoryCarrier(drivenTimers(clock)) : null
  const med: MediatorDouble | null = how.kind === 'mediator' ? mediatorDouble(undefined, () => clock.now()) : null
  const did = how.kind === 'live' ? how.did : (med?.did ?? '')
  const switches = new Map<string, (on: boolean) => void>()
  const devices = new Map<string, LoopbackDevice>()
  /** the code each phone shows last, newest last */
  const optics: { id: string; qr: string }[] = []
  let seed = 101
  for (const [i, p] of opts.people.entries()) {
    const pn = carrier ? null : phoneNet(med?.net ?? (how.kind === 'live' && how.insecure ? { policy: { allowInsecure: true, allowPrivate: true } } : {}))
    const d = await loopbackDevice({
      carrier: carrier ?? { mediator: { did, ...(pn ? { net: pn.net } : {}) } },
      id: p.id,
      name: p.name,
      words: LOOPBACK_PHRASES[i] ?? LOOPBACK_PHRASES[0],
      clock,
      seed: (seed += 17),
      language: opts.lang,
    })
    switches.set(p.id, (on) => {
      if (carrier) return carrier.setOnline(p.id, on)
      pn?.setOnline(on)
      d.platform.network.set(on ? 'online' : 'offline')
    })
    const trust = d.port.trust
    const showCard = trust.showCard.bind(trust)
    const sentCardFor = trust.sentCardFor.bind(trust)
    const send = trust.send.bind(trust)
    const shown = (qr: string) => {
      const at = optics.findIndex((o) => o.id === p.id)
      if (at >= 0) optics.splice(at, 1)
      optics.push({ id: p.id, qr })
    }
    Object.assign(trust, {
      send: (...args: Parameters<typeof send>) => {
        clock.advance(1000)
        return send(...args)
      },
      showCard: () => {
        const h = showCard()
        void h.done.then((r) => (r.ok ? shown(r.value.qr) : undefined))
        return h
      },
      sentCardFor: async (contactId: Parameters<typeof sentCardFor>[0]) => {
        const r = await sentCardFor(contactId)
        if (r.ok) shown(r.value.qr)
        return r
      },
    })
    devices.set(p.id, d)
  }
  // a phone's camera sees the code another phone showed last: the room's newest card that is not its
  // own, and only through an open lens (the page opens it once the phone has flown over the code)
  const ceremonyStore = writableStore<CeremonyState>({ scanning: null, showing: null, lens: false })
  const newestOther = (id: string) => [...optics].reverse().find((o) => o.id !== id) ?? null
  for (const p of opts.people) {
    const scanner = devices.get(p.id)?.platform.scanner as FakeScanner | undefined
    if (!scanner) continue
    scanner.source = () => (ceremonyStore.get().lens ? (newestOther(p.id)?.qr ?? null) : null)
    const scan = scanner.scan.bind(scanner)
    scanner.scan = async (o) => {
      ceremonyStore.set({ scanning: p.id, showing: newestOther(p.id)?.id ?? null, lens: false })
      try {
        return await scan(o)
      } finally {
        ceremonyStore.set({ scanning: null, showing: null, lens: false })
      }
    }
  }
  const ceremony = {
    ...ceremonyStore,
    land() {
      const c = ceremonyStore.get()
      if (c.scanning !== null && !c.lens) ceremonyStore.set({ ...c, lens: true })
    },
  }

  const settle = async () => {
    for (let calm = 0, i = 0; i < 400; i++) {
      await carrier?.settled()
      await med?.settled()
      for (const d of devices.values()) await d.port.session()?.idle()
      await new Promise((r) => setTimeout(r, 0))
      let busy = 0
      for (const d of devices.values()) busy += d.port.session()?.transportBusy() ?? 0
      calm = busy === 0 ? calm + 1 : 0
      if (calm >= 2) return
    }
    throw new Error('workbench: the phones never came to rest')
  }

  const meet = async (a: string, b: string) => {
    const A = devices.get(a), B = devices.get(b)
    if (!A || !B) throw new Error(`workbench: no phone ${a} / ${b}`)
    // a meeting takes a moment: the wire shows the order of what it left behind
    clock.advance(15_000)
    const shown = await B.port.trust.showCard().done
    if (!shown.ok) throw new Error('workbench: show')
    // god mode reads the code directly, no camera: the lens is not involved
    const scanned = await A.port.trust.confirmCard(shown.value.qr).done
    if (!scanned.ok) throw new Error('workbench: scan')
    await settle()
    // over a mediator B learns A's delivery hint from A's sent card (the optical leg)
    if (how.kind !== 'memory' && scanned.value.contactId) {
      const sent = await A.port.trust.sentCardFor(scanned.value.contactId)
      if (!sent.ok) throw new Error('workbench: sent card')
      const captured = await B.port.trust.confirmCard(sent.value.qr).done
      if (!captured.ok) throw new Error('workbench: capture')
      await settle()
    }
    const decisions = B.port.stores.decisions.get()
    const open = decisions.status === 'ready' ? decisions.value.find((d) => d.kind === 'encounter-confirm') : undefined
    if (!open || open.kind !== 'encounter-confirm') throw new Error(`workbench: no confirmation at ${b}`)
    clock.advance(5_000)
    await B.port.trust.counterVerify(open.contactId).done
    await settle()
    optics.length = 0
  }

  // the wire: one entry per submitted document, its disposition from the offers
  const entries: WireEntry[] = []
  const wire = writableStore<readonly WireEntry[]>([])
  let n = 0
  const unTap = carrier?.tap((e: CarrierEvent) => {
    if (e.kind === 'submitted') {
      entries.unshift({ n: ++n, digest: e.digest, from: e.from, type: shortType(e.type), threadId: e.threadId, attempt: e.attempt, at: clock.now(), to: null, disposition: 'in flight' })
    } else {
      const i = entries.findIndex((x) => x.digest === e.digest)
      if (i < 0) return
      const cur = entries[i]
      if (!cur || cur.disposition === 'taken') return
      if (e.answer === 'taken') entries[i] = { ...cur, to: e.to, disposition: 'taken' }
      else if (e.answer === 'later') entries[i] = { ...cur, to: e.to, disposition: 'refused for now' }
    }
    wire.set([...entries])
  })
  void unTap

  // the graph: re-derived whenever any contact list changes
  const graph = writableStore<{ readonly edges: readonly Edge[]; readonly rev: number }>({ edges: [], rev: 0 })
  let rev = 0
  const derive = () => {
    const views: DeviceContacts[] = opts.people.map((p) => {
      const d = devices.get(p.id)
      return { id: p.id, name: p.name, contacts: d ? contactsOf(d) : [] }
    })
    graph.set({ edges: edgesOf(views), rev: ++rev })
  }
  for (const d of devices.values()) d.port.stores.contacts.subscribe(derive)

  for (const [a, b] of opts.met) await meet(a, b)
  derive()

  const online = writableStore<Readonly<Record<string, boolean>>>(Object.fromEntries(opts.people.map((p) => [p.id, true])))
  return {
    carrier: how,
    clock,
    people: opts.people,
    devices,
    theme: opts.theme,
    online: {
      ...online,
      set(v) {
        for (const [id, on] of Object.entries(v)) if (online.get()[id] !== on) switches.get(id)?.(on)
        online.set(v)
      },
    },
    wire,
    wireObservable: carrier !== null,
    graph,
    ceremony,
    settle,
    meet,
  }
}

export function phoneComposition(world: WorkbenchWorld, id: string): Composition {
  const d = world.devices.get(id)
  if (!d) throw new Error(`workbench: no phone ${id}`)
  return { port: d.port, platform: d.platform, theme: world.theme }
}
