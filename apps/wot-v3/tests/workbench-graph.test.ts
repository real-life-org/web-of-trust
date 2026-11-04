// The workbench graph (architecture §7.4): edges are what the devices hold, nothing else. One edge per
// pair of people that hold each other as contacts, its state the most advanced either side reports;
// trust is directional, from what each side says it gave. A camera is a person: only the edges that
// touch them, and only the people at their ends; God's eye draws everything, which nobody holds.
import { describe, expect, it } from 'vitest'
import { edgesOf, sceneFor, type DeviceContacts } from '../harness/workbench/graph'

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

  it('as Mara: Mara and Noah, one one-sided edge', () => {
    const s = sceneFor('mara', people, edges)
    expect(s.nodes.map((n) => n.id).sort()).toEqual(['mara', 'noah'])
    expect(s.edges.map((e) => e.key)).toEqual(['mara|noah'])
  })

  it('an unknown camera falls back to God’s eye', () => {
    expect(sceneFor('nobody', people, edges).nodes).toHaveLength(4)
  })
})
