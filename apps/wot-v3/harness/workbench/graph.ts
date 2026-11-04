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
  readonly contacts: readonly { readonly name: string | null; readonly verification: Verification; readonly trust: { readonly given: boolean } }[]
}

export interface Edge {
  /** `${a}|${b}`, ids sorted */
  readonly key: string
  readonly a: string
  readonly b: string
  readonly verification: Verification
  /** the device ids that gave trust over this edge */
  readonly trust: readonly string[]
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
  readonly note: string
}

const RANK: Record<Verification, number> = { introduced: 0, met: 1, outgoing: 2, incoming: 2, mutual: 3 }

export function edgesOf(devices: readonly DeviceContacts[]): Edge[] {
  const byName = new Map<string, string[]>()
  for (const d of devices) byName.set(d.name, [...(byName.get(d.name) ?? []), d.id])
  const out = new Map<string, { a: string; b: string; verification: Verification; trust: Set<string> }>()
  for (const d of devices) {
    for (const c of d.contacts) {
      // the device whose owner carries that name, never this one
      const peer = c.name === null ? undefined : byName.get(c.name)?.find((id) => id !== d.id)
      if (!peer) continue
      const [a, b] = [d.id, peer].sort()
      const key = `${a}|${b}`
      let e = out.get(key)
      if (!e) {
        e = { a: a as string, b: b as string, verification: c.verification, trust: new Set() }
        out.set(key, e)
      } else if (RANK[c.verification] > RANK[e.verification]) e.verification = c.verification
      if (c.trust.given) e.trust.add(d.id)
    }
  }
  return [...out.entries()].map(([key, e]) => ({ key, a: e.a, b: e.b, verification: e.verification, trust: [...e.trust].sort() }))
}

export function sceneFor(camera: string, people: readonly Person[], edges: readonly Edge[]): Scene {
  const me = people.find((p) => p.id === camera)
  if (!me) {
    return {
      camera: 'god',
      nodes: people.map((p) => ({ ...p, me: false })),
      edges: [...edges],
      note: "God's eye: what actually happened. No device holds this view; switch the camera to a person to see what they can prove.",
    }
  }
  const mine = edges.filter((e) => e.a === me.id || e.b === me.id)
  const peers = new Set(mine.map((e) => (e.a === me.id ? e.b : e.a)))
  return {
    camera: me.id,
    nodes: people.filter((p) => p.id === me.id || peers.has(p.id)).map((p) => ({ ...p, me: p.id === me.id })),
    edges: mine,
    note: `Only what ${me.name} holds on their device. Everyone else does not exist for them.`,
  }
}
