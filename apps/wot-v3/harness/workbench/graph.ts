// The workbench graph (architecture §7.4): pure derivations from what the devices hold. An edge is a
// pair of people who hold each other as contacts (a contact resolves to the device whose owner carries
// that name: loopback names are unique by construction); its verification is the most advanced state
// either side reports, its trust the set of sides that gave it. A camera is a person: the scene then
// holds only the edges that touch them and the people at their ends. God's eye holds everything, and
// says so, because no device does.

import type { Verification } from '../../src/port'

export interface DeviceContacts {
  readonly id: string
  readonly name: string
  readonly contacts: readonly {
    readonly name: string | null
    readonly verification: Verification
    readonly trust: { readonly given: boolean; readonly received?: boolean }
    /** the names this contact's star says the device shares with it (Trust §5, sharedContacts) */
    readonly shared?: readonly string[]
    /** the device this contact is, as the world resolved it (review 503: never by a name that can
     *  change); without it the name decides (tests, a contact not resolved yet) */
    readonly peer?: string | null
    /** the devices this contact's star names, as resolved by the world; preferred over `shared` */
    readonly sharedPeers?: readonly string[]
  }[]
}

/** a pair a device knows of only through a contact's star: the contact and someone it shares */
export interface StarEdge {
  readonly key: string
  readonly a: string
  readonly b: string
}

export interface Edge {
  /** `${a}|${b}`, ids sorted */
  readonly key: string
  readonly a: string
  readonly b: string
  readonly verification: Verification
  /** the device ids that gave trust over this edge */
  readonly trust: readonly string[]
  /** the device ids that hold the other as a contact: a person's camera draws an edge only if it is one */
  readonly held: readonly string[]
  /** each holding device's own record of the other (review 503, #512): a person's camera draws the edge
   *  from this alone; only God's eye joins the devices' records */
  readonly views: Readonly<Record<string, { readonly verification: Verification; readonly given: boolean; readonly received: boolean }>>
}

export interface Person {
  readonly id: string
  readonly name: string
}

export interface SceneNode extends Person {
  readonly me: boolean
}

export interface Scene {
  readonly camera: string
  readonly nodes: readonly SceneNode[]
  readonly edges: readonly Edge[]
  /** pairs the camera knows of through its contacts' stars (person cameras only) */
  readonly stars: readonly StarEdge[]
  readonly note: string
}

const RANK: Record<Verification, number> = { introduced: 0, link: 0, met: 1, outgoing: 2, incoming: 2, mutual: 3 }

export function edgesOf(devices: readonly DeviceContacts[]): Edge[] {
  const byName = new Map<string, string[]>()
  for (const d of devices) byName.set(d.name, [...(byName.get(d.name) ?? []), d.id])
  const out = new Map<string, { a: string; b: string; verification: Verification; trust: Set<string>; held: Set<string>; views: Record<string, Edge['views'][string]> }>()
  for (const d of devices) {
    for (const c of d.contacts) {
      // the device whose owner carries that name, never this one
      const peer = c.peer !== undefined ? (c.peer ?? undefined) : c.name === null ? undefined : byName.get(c.name)?.find((id) => id !== d.id)
      if (!peer) continue
      const [a, b] = [d.id, peer].sort()
      const key = `${a}|${b}`
      let e = out.get(key)
      if (!e) {
        e = { a: a as string, b: b as string, verification: c.verification, trust: new Set(), held: new Set(), views: {} }
        out.set(key, e)
      } else if (RANK[c.verification] > RANK[e.verification]) e.verification = c.verification
      if (c.trust.given) e.trust.add(d.id)
      e.held.add(d.id)
      e.views[d.id] = { verification: c.verification, given: c.trust.given, received: c.trust.received ?? false }
    }
  }
  return [...out.entries()].map(([key, e]) => ({ key, a: e.a, b: e.b, verification: e.verification, trust: [...e.trust].sort(), held: [...e.held].sort(), views: e.views }))
}

/** per device: the pairs its contacts' stars name (the contact and the shared one), by device id */
export function starEdgesOf(devices: readonly DeviceContacts[]): Readonly<Record<string, readonly StarEdge[]>> {
  const byName = new Map<string, string[]>()
  for (const d of devices) byName.set(d.name, [...(byName.get(d.name) ?? []), d.id])
  const peerOf = (self: string, name: string | null) => (name === null ? undefined : byName.get(name)?.find((id) => id !== self))
  const out: Record<string, StarEdge[]> = {}
  for (const d of devices) {
    const seen = new Map<string, StarEdge>()
    for (const c of d.contacts) {
      const a = c.peer !== undefined ? (c.peer ?? undefined) : peerOf(d.id, c.name)
      if (!a) continue
      for (const b0 of c.sharedPeers ?? (c.shared ?? []).map((n) => peerOf(d.id, n))) {
        const b = b0 === undefined || b0 === d.id ? undefined : b0
        if (!b || b === a) continue
        const [x, y] = [a, b].sort() as [string, string]
        seen.set(`${x}|${y}`, { key: `${x}|${y}`, a: x, b: y })
      }
    }
    if (seen.size) out[d.id] = [...seen.values()]
  }
  return out
}

export function sceneFor(camera: string, people: readonly Person[], edges: readonly Edge[], stars: Readonly<Record<string, readonly StarEdge[]>> = {}): Scene {
  const me = people.find((p) => p.id === camera)
  if (!me) {
    return {
      camera: 'god',
      nodes: people.map((p) => ({ ...p, me: false })),
      edges: [...edges],
      stars: [],
      note: "God's eye: what actually happened. No device holds this view; switch the camera to a person to see what they can prove.",
    }
  }
  // only what the person's device holds: an edge the other side alone holds does not exist for them
  const mine = edges.flatMap((e): Edge[] => {
    const v = e.views[me.id]
    if (!v || (e.a !== me.id && e.b !== me.id)) return []
    const peer = e.a === me.id ? e.b : e.a
    // the edge as this device records it: its verification, the trust it gave, the trust it holds
    return [{ ...e, verification: v.verification, trust: [...(v.given ? [me.id] : []), ...(v.received ? [peer] : [])].sort(), held: [me.id], views: { [me.id]: v } }]
  })
  const peers = new Set(mine.map((e) => (e.a === me.id ? e.b : e.a)))
  const heard = (stars[me.id] ?? []).filter((e) => e.a !== me.id && e.b !== me.id)
  for (const e of heard) {
    peers.add(e.a)
    peers.add(e.b)
  }
  return {
    camera: me.id,
    nodes: people.filter((p) => p.id === me.id || peers.has(p.id)).map((p) => ({ ...p, me: p.id === me.id })),
    edges: mine,
    stars: heard,
    note: `Only what ${me.name} holds on their device. Everyone else does not exist for them.`,
  }
}
