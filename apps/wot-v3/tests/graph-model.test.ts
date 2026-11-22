// The graph tab's model (Anton 04.11.: "Graph" replaces the groups tab): what this device holds, drawn
// as a network. You in the middle; your contacts, sized by the relationship; their edges to you by
// verification and trust; edges between two contacts where a contact's star names the other (Trust §5).
// Nobody appears whom the device does not hold.
import { describe, expect, it } from 'vitest'
import { graphModel, lookOf, type GraphInput } from '../src/hooks/graph-model'
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
    expect(g.memberships.map((m) => [m.hub, m.node, m.by])).toEqual([
      ['g:garden', 'me', 'log'],
      ['g:garden', 'noah', 'log'],
      ['g:garden', 'lea', 'log'],
      // not confirmed in the choir yet: your line there is no membership
      ['g:choir', 'me', 'joining'],
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

  it('#543: your own line changes with the admission, the same line before and after', () => {
    // you accepted; the log names the founder alone
    const before = graphModel({ ...input, groups: [group('choir', 1, [], true)] })
    expect(before.memberships).toEqual([{ key: 'g:choir|me', hub: 'g:choir', node: 'me', by: 'joining' }])
    expect(before.hubs[0]).toMatchObject({ joining: true, members: 1 })
    // the log names you
    const after = graphModel({ ...input, groups: [group('choir', 2, [])] })
    expect(after.memberships).toEqual([{ key: 'g:choir|me', hub: 'g:choir', node: 'me', by: 'log' }])
    expect(after.hubs[0]).toMatchObject({ joining: false, members: 2 })
    // a membership the device holds while the log does not name you yet stays a joining line
    const unlisted = graphModel({ ...input, groups: [{ ...group('choir', 1, []), selfListed: false }] })
    expect(unlisted.memberships[0]?.by).toBe('joining')
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

describe('lookOf: how a line between you and a contact is drawn (Anton 22.11.)', () => {
  it('the ground by the verification: solid where it stands, dashed with an arrow from the one who verified', () => {
    expect(lookOf({ verification: 'mutual', trust: 'none' }).ground).toEqual({ kind: 'verified', dashed: false, arrow: null })
    expect(lookOf({ verification: 'met', trust: 'none' }).ground).toEqual({ kind: 'verified', dashed: false, arrow: null })
    expect(lookOf({ verification: 'outgoing', trust: 'none' }).ground).toEqual({ kind: 'verified', dashed: true, arrow: 'out' })
    expect(lookOf({ verification: 'incoming', trust: 'none' }).ground).toEqual({ kind: 'verified', dashed: true, arrow: 'in' })
  })

  it('nothing proven is dashed in its badge\'s colour: an introduction, a contact over a link', () => {
    expect(lookOf({ verification: 'introduced', trust: 'none' }).ground).toEqual({ kind: 'introduced', dashed: true, arrow: null })
    expect(lookOf({ verification: 'link', trust: 'none' }).ground).toEqual({ kind: 'link', dashed: true, arrow: null })
  })

  it('the trust is a line of its own on the ground: solid both ways, dashed with an arrow from the one who gave it', () => {
    expect(lookOf({ verification: 'mutual', trust: 'none' }).trust).toBeNull()
    expect(lookOf({ verification: 'mutual', trust: 'both' }).trust).toEqual({ dashed: false, arrow: null })
    expect(lookOf({ verification: 'mutual', trust: 'given' }).trust).toEqual({ dashed: true, arrow: 'out' })
    expect(lookOf({ verification: 'mutual', trust: 'received' }).trust).toEqual({ dashed: true, arrow: 'in' })
    // trust toward an introduced contact keeps its ground: green on yellow, not green on blue
    expect(lookOf({ verification: 'introduced', trust: 'both' })).toEqual({ ground: { kind: 'introduced', dashed: true, arrow: null }, trust: { dashed: false, arrow: null } })
  })
})
