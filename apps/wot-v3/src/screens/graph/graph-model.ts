// The graph tab's model (Anton 04.11.): what this device holds, as a network. You in the middle; your
// contacts, sized by the relationship (waiting small, mutual larger, with trust largest); their edges to
// you by verification and trust; edges between two contacts where a contact's star names the other
// (Trust §5, ContactDetail.sharedContacts). Nobody appears whom the device does not hold.

import type { ContactId, TrustState, Verification } from '../../port'

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

export interface StarEdge {
  readonly key: string
  readonly a: ContactId
  readonly b: ContactId
}

export interface GraphModel {
  readonly nodes: readonly GraphNode[]
  readonly mine: readonly MyEdge[]
  readonly stars: readonly StarEdge[]
}

const ME_SIZE = 28

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
  return { nodes, mine, stars: [...stars.values()] }
}
