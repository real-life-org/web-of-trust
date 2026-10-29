// The moment a relationship becomes mutual (handshake UX 2.7, E7): on both devices, wherever the
// person is in the app, once per relationship, only while the app is open. The moment comes from the
// published bundle (`verification === 'mutual'`, Encounter C5), never from a command result. The first
// view of the contacts after an opening is no moment (who had the app closed gets no late sheet), nor
// is a contact first seen as mutual (it was not seen becoming so).

import type { ContactId, Verification } from '../port'

export interface MutualWatch {
  /** each contact's verification as last seen; null before the first view */
  readonly seen: ReadonlyMap<string, Verification> | null
  /** contacts whose moment was shown in this session */
  readonly shown: ReadonlySet<string>
}

export const MUTUAL_WATCH: MutualWatch = { seen: null, shown: new Set() }

/** The next watch and the contacts that became mutual since the last view, in list order. */
export function watchMutual(w: MutualWatch, contacts: readonly { readonly id: ContactId; readonly verification: Verification }[]): { readonly watch: MutualWatch; readonly fresh: readonly ContactId[] } {
  const seen = new Map(contacts.map((c) => [c.id as string, c.verification] as const))
  if (w.seen === null) return { watch: { seen, shown: w.shown }, fresh: [] }
  const fresh: ContactId[] = []
  for (const c of contacts) {
    const before = w.seen.get(c.id)
    if (c.verification === 'mutual' && before !== undefined && before !== 'mutual' && !w.shown.has(c.id)) fresh.push(c.id)
  }
  return { watch: { seen, shown: fresh.length > 0 ? new Set([...w.shown, ...fresh]) : w.shown }, fresh }
}
