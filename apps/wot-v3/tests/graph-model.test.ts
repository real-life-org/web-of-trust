// The graph tab's model (Anton 04.11.: "Graph" replaces the groups tab): what this device holds, drawn
// as a network. You in the middle; your contacts, sized by the relationship; their edges to you by
// verification and trust; edges between two contacts where a contact's star names the other (Trust §5).
// Nobody appears whom the device does not hold.
import { describe, expect, it } from 'vitest'
import { graphModel, type GraphInput } from '../src/screens/graph/graph-model'
import type { ContactId, Verification } from '../src/port'

const c = (id: string, verification: Verification, given = false, received = false, shared: string[] | null = null, blocked = false) => ({
  id: id as ContactId,
  name: id[0]!.toUpperCase() + id.slice(1),
  image: null,
  verification,
  trust: { given, received, paused: false, pending: false },
  blocked,
  shared: shared as ContactId[] | null,
})

const input: GraphInput = {
  me: { name: 'Jonas', image: null },
  contacts: [c('noah', 'mutual', true, true, ['lea', 'stranger']), c('lea', 'mutual', false, true, ['noah']), c('sam', 'mutual'), c('mara', 'outgoing')],
}

describe('graphModel', () => {
  const g = graphModel(input)

  it('you and every contact, sized by the relationship: waiting small, mutual larger, trust largest', () => {
    const size = Object.fromEntries(g.nodes.map((n) => [n.id, n.size]))
    expect(g.nodes[0]).toMatchObject({ id: 'me', me: true })
    expect(size.mara).toBeLessThan(size.sam!)
    expect(size.sam).toBeLessThan(size.lea!)
    expect(size.lea).toBeLessThan(size.noah!)
    expect(size.noah).toBeLessThan(size.me!)
  })

  it('an edge from you to each contact, typed by verification, with the trust both ways', () => {
    expect(g.mine.map((e) => [e.contact, e.verification, e.trust])).toEqual([
      ['noah', 'mutual', 'both'],
      ['lea', 'mutual', 'received'],
      ['sam', 'mutual', 'none'],
      ['mara', 'outgoing', 'none'],
    ])
  })

  it('star edges between contacts, once per pair, only to contacts the device holds', () => {
    expect(g.stars).toEqual([{ key: 'lea|noah', a: 'lea', b: 'noah' }])
  })

  it('no contacts: you alone', () => {
    expect(graphModel({ me: { name: null, image: null }, contacts: [] })).toEqual({ nodes: [expect.objectContaining({ id: 'me' })], mine: [], stars: [] })
  })
})
