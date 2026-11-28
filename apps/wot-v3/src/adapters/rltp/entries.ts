// The one reading of a contact id (Trust 2140, 6a.4): an entry's aliases are the contacts merged or
// chained into it (a second meeting's fresh contact once the continuity mapping chained it). Every id the
// app holds from elsewhere (a command's input, a journaled record, a log line, a read mark, a prompt, a
// ceremony's contact, a screen or link that kept an earlier id) stands for the entry it belongs to now.
// The projection reads with it, the command service resolves a command's ids with it before the queue,
// the dedupe key and the journal see them, and reads the key of a running gesture or an open record with it
// (a record journaled under an id that became an alias later is read, never rewritten; what holds for its
// act is CONTACT-ORDER.md "A contact joined meanwhile").
import type { ContactView } from '@real-life/trust-protocol'

export interface Entries {
  /** the entry `id` stands for now: itself, or the entry it is an alias of */
  (id: string): string
  /** no alias at all: every id stands for itself */
  readonly none: boolean
}

export function entryIds(contacts: readonly ContactView[]): Entries {
  const of = new Map<string, string>()
  for (const c of contacts) for (const a of c.aliases) if (a !== c.id) of.set(a, c.id)
  return Object.assign((id: string) => of.get(id) ?? id, { none: of.size === 0 })
}

/** a conversation or command target (`c:<id>`) as its entry's; any other target as it is */
export const entryKey = <K extends string>(entry: Entries, key: K): K => (key.startsWith('c:') ? (`c:${entry(key.slice(2))}` as K) : key)

/** a dedupe key (`command|<part>|…`) of a command on `contactId`, with that part read as its entry; a key of
 *  a command without a contact (a group, a draft, a prompt) as it is */
export const entryDedupe = (entry: Entries, dedupe: string, contactId: unknown): string =>
  typeof contactId !== 'string' || entry(contactId) === contactId ? dedupe : dedupe.split('|').map((part) => (part === contactId ? entry(contactId) : part)).join('|')

/** a command's input with its contact id read as its entry */
export const entryInput = <I extends Readonly<Record<string, unknown>>>(entry: Entries, input: I): I =>
  typeof input.contactId === 'string' && entry(input.contactId) !== input.contactId ? { ...input, contactId: entry(input.contactId) } : input
