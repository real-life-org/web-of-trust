// The workbench graph (architecture §7.4): edges are what the devices hold, nothing else. One edge per
// pair of people that hold each other as contacts, its state the most advanced either side reports;
// trust is directional, from what each side says it gave. A camera is a person: only the edges that
// touch them, and only the people at their ends; God's eye draws everything, which nobody holds.
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { edgesOf, sceneFor, sceneLinks, starEdgesOf, type DeviceContacts, type DeviceGroup } from '../harness/workbench/graph'

const contact = (name: string, verification: 'mutual' | 'outgoing' | 'incoming' | 'met' | 'introduced', given = false, received = false) => ({
  name,
  verification,
  trust: { given, received, paused: false, pending: false },
})

const three: DeviceContacts[] = [
  { id: 'jonas', name: 'Jonas Weber', contacts: [contact('Noah Lindqvist', 'mutual', false, true), contact('Lea Brandt', 'mutual', true, true)] },
  { id: 'noah', name: 'Noah Lindqvist', contacts: [contact('Jonas Weber', 'mutual', true), contact('Lea Brandt', 'mutual'), contact('Mara Kowalski', 'outgoing')] },
  { id: 'lea', name: 'Lea Brandt', contacts: [contact('Jonas Weber', 'mutual', true, true), contact('Noah Lindqvist', 'mutual')] },
  { id: 'mara', name: 'Mara Kowalski', contacts: [] },
]

describe('edgesOf: one edge per pair, from what both devices hold', () => {
  it('three met pairwise and one scanned once: four edges, keyed by the two device ids', () => {
    const edges = edgesOf(three)
    expect(edges.map((e) => e.key).sort()).toEqual(['jonas|lea', 'jonas|noah', 'lea|noah', 'mara|noah'])
  })

  it('verification is the most advanced either side reports: mutual beats one-sided', () => {
    const by = Object.fromEntries(edgesOf(three).map((e) => [e.key, e]))
    expect(by['jonas|noah']?.verification).toBe('mutual')
    // Mara holds nothing yet: Noah's side alone says outgoing
    expect(by['mara|noah']?.verification).toBe('outgoing')
  })

  it('trust is directional: who gave it, from that side only', () => {
    const by = Object.fromEntries(edgesOf(three).map((e) => [e.key, e]))
    expect(by['jonas|noah']?.trust).toEqual(['noah'])
    expect(by['jonas|lea']?.trust.slice().sort()).toEqual(['jonas', 'lea'])
    expect(by['lea|noah']?.trust).toEqual([])
  })

  it('a contact whose name no device carries is an edge to nobody: left out', () => {
    const edges = edgesOf([{ id: 'a', name: 'A', contacts: [contact('Stranger', 'mutual')] }])
    expect(edges).toEqual([])
  })

  it('a contact that resolves to the device itself (same name twice) is no edge', () => {
    const edges = edgesOf([
      { id: 'a', name: 'Same', contacts: [contact('Same', 'mutual')] },
      { id: 'b', name: 'Same', contacts: [] },
    ])
    expect(edges.map((e) => e.key)).toEqual(['a|b'])
  })
})

describe('sceneFor: what a camera can show', () => {
  const people = three.map((d) => ({ id: d.id, name: d.name }))
  const edges = edgesOf(three)

  it("God's eye: every person and every edge", () => {
    const s = sceneFor('god', people, edges)
    expect(s.nodes.map((n) => n.id).sort()).toEqual(['jonas', 'lea', 'mara', 'noah'])
    expect(s.edges).toHaveLength(4)
    expect(s.note).toMatch(/no device holds this/i)
  })

  it('as Jonas: Jonas and his two peers, his two edges; Mara and the Noah–Lea edge do not exist for him', () => {
    const s = sceneFor('jonas', people, edges)
    expect(s.nodes.map((n) => n.id).sort()).toEqual(['jonas', 'lea', 'noah'])
    expect(s.edges.map((e) => e.key).sort()).toEqual(['jonas|lea', 'jonas|noah'])
    expect(s.nodes.find((n) => n.id === 'jonas')?.me).toBe(true)
    expect(s.note).toContain('Jonas Weber')
  })

  it('as Mara, who holds nothing yet: Mara alone (Noah scanned her, her device knows nothing of it; CodeRabbit 503)', () => {
    const s = sceneFor('mara', people, edges)
    expect(s.nodes.map((n) => n.id)).toEqual(['mara'])
    expect(s.edges).toEqual([])
  })

  it('as Noah, who holds Mara: the one-sided edge is his', () => {
    expect(sceneFor('noah', people, edges).edges.map((e) => e.key)).toContain('mara|noah')
  })

  it('an unknown camera falls back to God’s eye', () => {
    expect(sceneFor('nobody', people, edges).nodes).toHaveLength(4)
  })
})

describe('known through a star: what a camera learns beyond its own edges', () => {
  // Noah holds Jonas and Lea; Jonas's star to Noah hit Lea (Lea trusted Jonas and Noah): Noah learns
  // that Jonas knows Lea. Nobody's star told Jonas anything.
  const devices: DeviceContacts[] = [
    { id: 'jonas', name: 'Jonas Weber', contacts: [contact('Noah Lindqvist', 'mutual'), contact('Lea Brandt', 'mutual')] },
    { id: 'noah', name: 'Noah Lindqvist', contacts: [{ ...contact('Jonas Weber', 'mutual'), shared: ['Lea Brandt'] }, contact('Lea Brandt', 'mutual')] },
    { id: 'lea', name: 'Lea Brandt', contacts: [contact('Jonas Weber', 'mutual'), contact('Noah Lindqvist', 'mutual')] },
  ]
  const people = devices.map((d) => ({ id: d.id, name: d.name }))
  const edges = edgesOf(devices)
  const stars = starEdgesOf(devices)

  it('per device: the pairs its contacts\' stars name, by device id', () => {
    expect(stars).toEqual({ noah: [{ key: 'jonas|lea', a: 'jonas', b: 'lea' }] })
  })

  it('as Noah: his own two edges, and Jonas–Lea as known through a star', () => {
    const s = sceneFor('noah', people, edges, stars)
    expect(s.edges.map((e) => e.key).sort()).toEqual(['jonas|noah', 'lea|noah'])
    expect(s.stars.map((e) => e.key)).toEqual(['jonas|lea'])
  })

  it('as Jonas: no star told him anything; God\'s eye draws what happened, no star lines', () => {
    expect(sceneFor('jonas', people, edges, stars).stars).toEqual([])
    expect(sceneFor('god', people, edges, stars).stars).toEqual([])
  })

  it('a star naming someone the camera does not hold adds that person to the scene', () => {
    const s = sceneFor('noah', people, edges.filter((e) => e.key !== 'lea|noah'), stars)
    expect(s.nodes.map((n) => n.id).sort()).toEqual(['jonas', 'lea', 'noah'])
  })
})

describe('a person\'s camera reads only its own device (review 503, #512)', () => {
  const people = [{ id: 'jonas', name: 'Jonas Weber' }, { id: 'noah', name: 'Noah Lindqvist' }]
  const world = (noahGives: boolean, jonasReceived: boolean, jonasVer: 'met' | 'mutual' = 'mutual'): DeviceContacts[] => [
    { id: 'jonas', name: 'Jonas Weber', contacts: [contact('Noah Lindqvist', jonasVer, false, jonasReceived)] },
    { id: 'noah', name: 'Noah Lindqvist', contacts: [contact('Jonas Weber', 'mutual', noahGives)] },
  ]
  const jonasView = (devices: DeviceContacts[]) => {
    const s = sceneFor('jonas', people, edgesOf(devices))
    return s.edges.map((e) => ({ key: e.key, verification: e.verification, trust: e.trust }))
  }

  it('Noah gives trust, nothing delivered yet: God\'s eye shows it, Jonas\'s camera does not change', () => {
    const before = jonasView(world(false, false))
    expect(jonasView(world(true, false))).toEqual(before)
    expect(sceneFor('god', people, edgesOf(world(true, false))).edges[0]?.trust).toEqual(['noah'])
  })

  it('delivered (Jonas\'s device holds "trusts you"): Jonas\'s camera shows Noah\'s trust toward him', () => {
    expect(jonasView(world(true, true))).toEqual([{ key: 'jonas|noah', verification: 'mutual', trust: ['noah'] }])
  })

  it('verification as the person\'s own device says it: met at Jonas stays met, though Noah says mutual', () => {
    expect(jonasView(world(false, false, 'met'))[0]?.verification).toBe('met')
  })
})


describe('sceneFor: groups are hubs, from what each device holds of them', () => {
  const people = three.map((d) => ({ id: d.id, name: d.name }))
  const edges = edgesOf(three)
  const garden = (members: string[], unknown: number, joining = false): DeviceGroup => ({ id: 'garden', name: 'Garden Crew', joining, members, unknown, confirmed: 3 })
  // Jonas founded it and holds Lea as a member; Noah is in it and knows nobody there; Mara is joining
  const groups = { jonas: [garden(['lea'], 2)], lea: [garden(['jonas'], 2)], noah: [garden([], 3)], mara: [garden([], 3, true)] }

  it("a person's camera: their own groups, joined to them and to the members they hold as contacts; the rest a number", () => {
    const scene = sceneFor('jonas', people, edges, {}, groups)
    expect(scene.groups).toEqual([{ id: 'garden', name: 'Garden Crew', members: [{ id: 'jonas', by: 'log' }, { id: 'lea', by: 'log' }], unknown: 2, confirmed: 3 }])
    expect(sceneFor('noah', people, edges, {}, groups).groups[0]).toMatchObject({ members: [{ id: 'noah', by: 'log' }], unknown: 3 })
  })

  it('a member the camera does not hold as a contact has no node: one more of the unknown', () => {
    const scene = sceneFor('mara', people, edges, {}, { mara: [garden(['jonas'], 2, true)] })
    expect(scene.groups[0]).toEqual({ id: 'garden', name: 'Garden Crew', members: [{ id: 'mara', by: 'joining' }], unknown: 3, confirmed: 3 })
  })

  it("God's eye: every group once, joined to every phone that is in it", () => {
    const scene = sceneFor('god', people, edges, {}, groups)
    expect(scene.groups).toHaveLength(1)
    expect(scene.groups[0]?.members.map((m) => m.id).sort()).toEqual(['jonas', 'lea', 'mara', 'noah'])
    expect(scene.groups[0]?.members.find((m) => m.id === 'mara')?.by).toBe('joining')
    expect(scene.groups[0]?.unknown).toBe(0)
  })

  it('#539: one who is joining has a line and is not counted, from either camera', () => {
    // Jonas founded it, Mara is joining: Jonas' log names him alone, Mara's names the founder alone
    const pending = {
      jonas: [{ id: 'duo', name: 'Duo', joining: false, members: [], unknown: 0, confirmed: 1 }],
      mara: [{ id: 'duo', name: 'Duo', joining: true, members: [], unknown: 1, confirmed: 1 }],
    }
    const god = sceneFor('god', people, edges, {}, pending).groups[0]
    expect(god?.members).toEqual([{ id: 'jonas', by: 'log' }, { id: 'mara', by: 'joining' }])
    expect(god?.confirmed).toBe(1)
    const mara = sceneFor('mara', people, edges, {}, pending).groups[0]
    expect(mara).toMatchObject({ members: [{ id: 'mara', by: 'joining' }], unknown: 1, confirmed: 1 })
    expect(sceneFor('jonas', people, edges, {}, pending).groups[0]).toMatchObject({ members: [{ id: 'jonas', by: 'log' }], unknown: 0, confirmed: 1 })
  })

  it("#542: a contact's word is a line of its own kind for that camera; the dots stay", () => {
    // Noah's log names him and two he cannot place; Lea, his contact, says by her star that she is in it
    const said = { noah: [{ id: 'garden', name: 'Garden Crew', joining: false, members: [], said: ['lea', 'mara'], unknown: 2, confirmed: 3 }] }
    const scene = sceneFor('noah', people, edges, {}, said)
    // Mara is held as a contact too (scanned once): both are drawn by their word
    expect(scene.groups[0]?.members).toEqual([{ id: 'noah', by: 'log' }, { id: 'lea', by: 'said' }, { id: 'mara', by: 'said' }])
    expect(scene.groups[0]).toMatchObject({ unknown: 2, confirmed: 3 })
  })

  it('no groups: none in the scene', () => {
    expect(sceneFor('jonas', people, edges).groups).toEqual([])
  })
})

describe('sceneLinks: the lines of the workbench, in the app graph\'s language (#545, #546)', () => {
  const people = [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }]
  const edge = (verification: 'mutual' | 'outgoing' | 'incoming' | 'met' | 'introduced' | 'link', given = false, received = false) =>
    sceneFor('god', people, edgesOf([
      { id: 'a', name: 'A', contacts: [{ name: 'B', verification, trust: { given, received } }] },
      { id: 'b', name: 'B', contacts: [] },
    ]))
  const links = (...args: Parameters<typeof edge>) => sceneLinks(edge(...args)).map((l) => [l.cls, l.source, l.target, l.arrow ?? null])

  it('the ground: solid only for a mutual verification; met, and neither side verified, is open and nobody\'s arrow', () => {
    expect(links('mutual')).toEqual([['wb-edge', 'a', 'b', null]])
    expect(links('met')).toEqual([['wb-edge one', 'a', 'b', null]])
  })

  it('one-sided: dashed, with the arrow from the one who verified', () => {
    expect(links('outgoing')).toEqual([['wb-edge one', 'a', 'b', 'verified']])
    expect(links('incoming')).toEqual([['wb-edge one', 'b', 'a', 'verified']])
  })

  it('nothing proven keeps its own colour: an introduction, a contact over a link', () => {
    expect(links('introduced')).toEqual([['wb-edge via', 'a', 'b', null]])
    expect(links('link')).toEqual([['wb-edge link', 'a', 'b', null]])
  })

  it('the trust is a line of its own on the ground; one way it carries the only arrow', () => {
    expect(links('mutual', true)).toEqual([['wb-edge', 'a', 'b', null], ['wb-edge trust1', 'a', 'b', 'trust']])
    expect(links('outgoing', true)).toEqual([['wb-edge one', 'a', 'b', null], ['wb-edge trust1', 'a', 'b', 'trust']])
  })

  it('#545: the stylesheet draws each class once, the trust green and never amber', () => {
    const css = readFileSync(resolve(__dirname, '../harness/workbench/workbench.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')
    const rules = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => ({ selectors: m[1]!.split(',').map((s) => s.trim()), body: m[2]! }))
    const strokeOf = (cls: string) => rules.filter((r) => r.selectors.includes(cls)).flatMap((r) => [...r.body.matchAll(/(?:^|[\s;])stroke:\s*([^;]+);/g)].map((m) => m[1]!.trim()))
    expect(strokeOf('.wb-edge.trust1')).toEqual(['var(--wb-green)'])
    expect(strokeOf('.wb-edge.trust2')).toEqual(['var(--wb-green)'])
    expect(strokeOf('.wb-edge')).toEqual(['var(--wb-primary)'])
    expect(strokeOf('.wb-edge.via')).toEqual(['var(--wb-amber)'])
    expect(strokeOf('.wb-edge.link')).toEqual(['var(--wb-red)'])
    expect(strokeOf('.wb-edge.member')).toEqual(['var(--wb-muted)'])
    // a class has one width and one dash, wherever the stylesheet names it
    for (const cls of ['.wb-edge', '.wb-edge.one', '.wb-edge.trust1', '.wb-edge.trust2', '.wb-edge.member', '.wb-edge.star']) {
      const widths = rules.filter((r) => r.selectors.includes(cls)).flatMap((r) => [...r.body.matchAll(/stroke-width:\s*([^;]+);/g)])
      expect(widths.length, cls).toBeLessThanOrEqual(1)
    }
  })
})
