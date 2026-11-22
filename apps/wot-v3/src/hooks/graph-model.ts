// The graph tab's model (Anton 04.11.): what this device holds, as a network. You in the middle; your
// contacts, sized by the relationship (waiting small, mutual larger, with trust largest); their edges to
// you by verification and trust; edges between two contacts where a contact's star names the other
// (Trust §5, ContactDetail.sharedContacts). Nobody appears whom the device does not hold.
//
// Groups are hubs: one per group you are in or are joining, an edge from you and from every contact the
// group's log names as a member. The members the device knows by handle only have no node; the hub
// carries their number. A contact whose group star names the group is joined to it in the star's own
// line: the contact says so, and no member of the log is known to be that contact.

import type { ContactId, GroupId, TrustState, Verification } from '../port'

export interface GraphInput {
  readonly me: { readonly name: string | null; readonly image: string | null }
  readonly contacts: readonly {
    readonly id: ContactId
    readonly name: string | null
    readonly image: string | null
    readonly verification: Verification
    readonly trust: TrustState
    readonly blocked: boolean
    /** the contacts this contact's star names (null: none arrived) */
    readonly shared: readonly ContactId[] | null
  }[]
  /** the groups this device is in or is joining */
  readonly groups?: readonly {
    readonly id: GroupId
    readonly name: string
    readonly joining: boolean
    /** every member the group's log names: you among them once the group confirmed you */
    readonly knownMembers: number
    /** the log names you: not yet, as a rule, while you are joining */
    readonly selfListed: boolean
    /** the members of the group's log this device holds as contacts (empty where the details did not arrive) */
    readonly contacts: readonly ContactId[]
    /** the contacts whose group star names this group: the contact's word, tied to no member of the log */
    readonly said?: readonly ContactId[]
  }[]
}

export interface GraphNode {
  /** 'me' or the contact id */
  readonly id: string
  readonly me: boolean
  readonly name: string | null
  readonly image: string | null
  /** radius in px */
  readonly size: number
}

export type TrustBetween = 'both' | 'given' | 'received' | 'none'

export interface MyEdge {
  readonly contact: ContactId
  readonly verification: Verification
  readonly trust: TrustBetween
}

/** How a line between you and a contact is drawn, the same in the app and on the workbench.
 *  The stroke says how sure: solid stands, dashed is one-sided or open (with an arrow from the one who
 *  acted), dotted is someone else's word. The colour says what: blue the verification, yellow an
 *  introduction, red a contact over a link, green the trust. The trust is a narrower line on its
 *  ground, so the ground shows as its rim, and through the gaps of a one-sided trust. */
export interface EdgeLook {
  readonly ground: { readonly kind: 'verified' | 'introduced' | 'link'; readonly dashed: boolean; readonly arrow: 'out' | 'in' | null }
  readonly trust: { readonly dashed: boolean; readonly arrow: 'out' | 'in' | null } | null
}

export function lookOf(e: Pick<MyEdge, 'verification' | 'trust'>): EdgeLook {
  const v = e.verification
  const ground: EdgeLook['ground'] =
    v === 'introduced' ? { kind: 'introduced', dashed: true, arrow: null }
    : v === 'link' ? { kind: 'link', dashed: true, arrow: null }
    : v === 'outgoing' ? { kind: 'verified', dashed: true, arrow: 'out' }
    : v === 'incoming' ? { kind: 'verified', dashed: true, arrow: 'in' }
    : { kind: 'verified', dashed: false, arrow: null }
  const trust: EdgeLook['trust'] =
    e.trust === 'both' ? { dashed: false, arrow: null } : e.trust === 'given' ? { dashed: true, arrow: 'out' } : e.trust === 'received' ? { dashed: true, arrow: 'in' } : null
  return { ground, trust }
}

export interface StarEdge {
  readonly key: string
  readonly a: ContactId
  readonly b: ContactId
}

export interface GroupHub {
  /** `g:${group}`: never a contact's id */
  readonly id: string
  readonly group: GroupId
  readonly name: string
  /** your membership is not confirmed yet */
  readonly joining: boolean
  /** radius in px */
  readonly size: number
  /** the members the group's log names: you are one of them only once you are confirmed */
  readonly members: number
  /** the members that are no contact of yours: drawn as dots at the hub, nobody in particular */
  readonly unknown: number
}

export interface MemberEdge {
  readonly key: string
  readonly hub: string
  /** 'me' or the contact id */
  readonly node: string
  /** why the line is drawn */
  readonly by: MemberBy
}

/** What the device knows of a person and a group:
 *  `log`: the group's log names this member, and the device knows who it is: a confirmed membership.
 *  `joining`: you accepted the invitation and the group has not confirmed you: not a member yet.
 *  `said`: the contact's group star names the group; which member of the log it is, or whether it
 *  still is one, is open. */
export type MemberBy = 'log' | 'joining' | 'said'

export interface GraphModel {
  readonly nodes: readonly GraphNode[]
  readonly mine: readonly MyEdge[]
  readonly stars: readonly StarEdge[]
  readonly hubs: readonly GroupHub[]
  readonly memberships: readonly MemberEdge[]
}

const ME_SIZE = 28
const HUB_SIZE = 19

function sizeOf(verification: Verification, trust: TrustBetween): number {
  if (verification !== 'mutual' && verification !== 'met') return 12
  if (trust === 'both') return 24
  if (trust !== 'none') return 21
  return 17
}

const trustOf = (t: TrustState): TrustBetween => (t.given && t.received ? 'both' : t.given ? 'given' : t.received ? 'received' : 'none')

export function graphModel(input: GraphInput): GraphModel {
  const held = new Set<string>(input.contacts.map((c) => c.id))
  const nodes: GraphNode[] = [{ id: 'me', me: true, name: input.me.name, image: input.me.image, size: ME_SIZE }]
  const mine: MyEdge[] = []
  const stars = new Map<string, StarEdge>()
  for (const c of input.contacts) {
    const trust = trustOf(c.trust)
    nodes.push({ id: c.id, me: false, name: c.name, image: c.image, size: sizeOf(c.verification, trust) })
    mine.push({ contact: c.id, verification: c.verification, trust })
    for (const other of c.shared ?? []) {
      if (other === c.id || !held.has(other)) continue
      const [a, b] = [c.id, other].sort() as [ContactId, ContactId]
      stars.set(`${a}|${b}`, { key: `${a}|${b}`, a, b })
    }
  }
  const hubs: GroupHub[] = []
  const memberships: MemberEdge[] = []
  for (const g of input.groups ?? []) {
    const id = `g:${g.id}`
    const linked = [...new Set(g.contacts)].filter((c) => held.has(c))
    hubs.push({ id, group: g.id, name: g.name, joining: g.joining, size: HUB_SIZE, members: g.knownMembers, unknown: Math.max(0, g.knownMembers - (g.selfListed ? 1 : 0) - linked.length) })
    // your own line is a membership only once the log names you
    memberships.push({ key: `${id}|me`, hub: id, node: 'me', by: g.joining || !g.selfListed ? 'joining' : 'log' })
    for (const c of linked) memberships.push({ key: `${id}|${c}`, hub: id, node: c, by: 'log' })
    // a contact's word takes no dot away: a dot goes only where the log's member is known to be the contact
    for (const c of new Set(g.said ?? [])) if (held.has(c) && !linked.includes(c)) memberships.push({ key: `${id}|${c}`, hub: id, node: c, by: 'said' })
  }
  return { nodes, mine, stars: [...stars.values()], hubs, memberships }
}
