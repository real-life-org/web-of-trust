// Ingest (architecture §3.1 "Übernahme", N1, N4): pure derivation of what app-db keeps from one
// sync step: the events taken over since the last one and the views at the new fence. The session
// writes the result together with the applied mark in one app-db transaction.

import type { ContactView, HolderEvent, PromptView } from '@real-life/trust-protocol'
import { CHALLENGE_MAX_AGE } from '@real-life/trust-protocol'
import type { ConversationKey, SystemKind } from '../../port'
import type { EncounterCache, Ledger, LogLine } from './app-data'
import { encodeCardLink } from './card-link'

export interface IngestInput {
  readonly commitSeq: string
  readonly now: number
  readonly events: readonly HolderEvent[]
  readonly contacts: readonly ContactView[]
  readonly prompts: readonly PromptView[]
  readonly encounters: EncounterCache
  readonly ledger: Ledger
}

export interface IngestOutput {
  readonly encounters: EncounterCache
  readonly ledger: Ledger
  readonly lines: readonly LogLine[]
}

const DAY = 86_400_000

export function ingest(input: IngestInput): IngestOutput {
  const { now, events, commitSeq } = input
  const own = { ...input.encounters.own }
  const sent = { ...input.encounters.sent }
  const met = { ...input.encounters.met }
  const lines: LogLine[] = []
  const recorded = new Set<string>()
  const chained = new Set<string>()
  const line = (contactId: string, system: SystemKind, basis: 'event' | 'observed', at = now): void => {
    const key: ConversationKey = `c:${contactId}`
    lines.push({ kind: 'system', id: `sys:${contactId}:${commitSeq}:${system}`, key, at, system, basis })
  }

  for (const e of events) {
    switch (e.type) {
      case 'encounter.shown': {
        const ch = (e.card as { challenge?: { issuedAt?: unknown } }).challenge
        const issuedAt = typeof ch?.issuedAt === 'string' ? Date.parse(ch.issuedAt) : now
        own[e.challenge] = { qr: encodeCardLink(e.card), issuedAt, expiresAt: issuedAt + CHALLENGE_MAX_AGE }
        break
      }
      case 'encounter.scanned':
        sent[e.contactId] = { qr: encodeCardLink(e.card) }
        break
      case 'encounter.recorded': {
        recorded.add(e.contactId)
        const m = met[e.contactId]
        met[e.contactId] = { metAt: m?.metAt ?? now, lastMetAt: now }
        break
      }
      case 'contact.chained': {
        chained.add(e.contactId)
        const m = met[e.contactId]
        met[e.contactId] = { metAt: m?.metAt ?? now, lastMetAt: now }
        break
      }
      default:
        break
    }
  }
  // own cards are kept a day past their expiry, then dropped
  for (const [k, v] of Object.entries(own)) if (v.expiresAt + DAY < now) delete own[k]

  const ledgerContacts = { ...input.ledger.contacts }
  for (const c of input.contacts) {
    const before = ledgerContacts[c.id]
    const after = { verification: c.verification, given: c.trust.given, received: c.trust.received, blocked: c.blocked }
    if (!before) {
      const first: SystemKind | null = c.verification === 'mutual' ? 'mutual' : c.verification === 'outgoing' ? 'outgoing' : c.verification === 'incoming' ? 'incoming' : null
      if (first) line(c.id, first, recorded.has(c.id) ? 'event' : 'observed', met[c.id]?.metAt ?? now)
    } else {
      if (chained.has(c.id)) line(c.id, 'remet', 'event')
      if (before.verification !== 'mutual' && c.verification === 'mutual') line(c.id, 'nowMutual', 'observed')
      if (!before.given && after.given) line(c.id, 'trustOut', 'observed')
      if (before.given && !after.given) line(c.id, 'trustWithdrawn', 'observed')
      if (!before.received && after.received) line(c.id, 'trustIn', 'observed')
    }
    if (c.verification === 'mutual') delete sent[c.id]
    ledgerContacts[c.id] = after
  }

  const ledgerPrompts = { ...input.ledger.prompts }
  for (const p of input.prompts) {
    if (ledgerPrompts[p.id]) continue
    ledgerPrompts[p.id] = { contactId: p.contactId ?? null, kind: p.kind, openedAt: p.openedAt }
    if (p.kind === 'encounter-confirm' && p.contactId !== undefined) {
      lines.push({ kind: 'decision', id: `dec:${p.id}`, key: `c:${p.contactId}`, at: p.openedAt, decision: p.id })
    }
  }

  return { encounters: { own, sent, met }, ledger: { contacts: ledgerContacts, prompts: ledgerPrompts }, lines }
}
