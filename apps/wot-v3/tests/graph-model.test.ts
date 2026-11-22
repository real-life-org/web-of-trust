// The graph tab's model (Anton 04.11.: "Graph" replaces the groups tab): what this device holds, drawn
// as a network. You in the middle; your contacts, sized by the relationship; their edges to you by
// verification and trust; edges between two contacts where a contact's star names the other (Trust §5).
// Nobody appears whom the device does not hold.
import { describe, expect, it } from 'vitest'
import { graphModel, type GraphInput } from '../src/hooks/graph-model'
import type { ContactId, GroupId, Verification } from '../src/port'

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
    expect(graphModel({ me: { name: null, image: null }, contacts: [] })).toEqual({ nodes: [expect.objectContaining({ id: 'me' })], mine: [], stars: [], hubs: [], memberships: [] })
  })
})

describe('graphModel: groups are hubs', () => {
  const group = (id: string, knownMembers: number, contacts: string[], joining = false) => ({ id: id as GroupId, name: id, joining, knownMembers, selfListed: !joining, contacts: contacts as ContactId[] })
  const g = graphModel({ ...input, groups: [group('garden', 5, ['noah', 'lea', 'stranger']), group('choir', 1, [], true)] })

  it('one hub per group, never under a contact\'s id; the people stay as they were', () => {
    expect(g.hubs.map((h) => [h.id, h.group, h.joining])).toEqual([
      ['g:garden', 'garden', false],
      ['g:choir', 'choir', true],
    ])
    expect(g.nodes.map((n) => n.id)).toEqual(['me', 'noah', 'lea', 'sam', 'mara'])
  })

  it('a membership edge from you and from every member the device holds as a contact, nobody else', () => {
    expect(g.memberships.map((m) => [m.hub, m.node])).toEqual([
      ['g:garden', 'me'],
      ['g:garden', 'noah'],
      ['g:garden', 'lea'],
      ['g:choir', 'me'],
    ])
  })

  it('the members that are no contact are a number at the hub: all of them, less you and the ones drawn', () => {
    const by = Object.fromEntries(g.hubs.map((h) => [h.group, h]))
    expect(by.garden).toMatchObject({ members: 5, unknown: 2 })
    expect(by.choir).toMatchObject({ members: 1, unknown: 1 })
  })

  it('#542: a contact whose group star names the group is joined by its word, and takes no dot away', () => {
    // the log names you, Noah and one member nobody here knows; Lea says she is in it
    const said = graphModel({ ...input, groups: [{ ...group('garden', 3, ['noah']), said: ['lea', 'noah', 'stranger'] as ContactId[] }] })
    expect(said.memberships.map((m) => [m.node, m.by])).toEqual([['me', 'log'], ['noah', 'log'], ['lea', 'said']])
    expect(said.hubs[0]).toMatchObject({ members: 3, unknown: 1 })
    // the log names you alone, and Lea's last star still names the group: one member, a line by her word
    const stale = graphModel({ ...input, groups: [{ ...group('garden', 1, []), said: ['lea'] as ContactId[] }] })
    expect(stale.hubs[0]).toMatchObject({ members: 1, unknown: 0 })
    expect(stale.memberships.map((m) => [m.node, m.by])).toEqual([['me', 'log'], ['lea', 'said']])
  })

  it('#539: while you are joining the log does not name you yet: nothing is taken off for you', () => {
    // the founder alone is in the log, and is no contact of yours: one dot, one member
    const joining = graphModel({ ...input, groups: [group('choir', 1, [], true)] }).hubs[0]
    expect(joining).toMatchObject({ joining: true, members: 1, unknown: 1 })
    // the same log once it names you: you and the founder, still one dot
    const confirmed = graphModel({ ...input, groups: [group('choir', 2, [])] }).hubs[0]
    expect(confirmed).toMatchObject({ joining: false, members: 2, unknown: 1 })
  })
})
