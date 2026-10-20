// Ingest (architecture §3.1 "Übernahme", N1, N4): pure derivation of what app-db keeps from one
// sync step: the events taken over since the last one and the views at the new fence. The session
// writes the result together with the applied mark in one app-db transaction.

import type { ContactView, DeliveryItemView, HolderEvent, InboxMessageView, PromptView } from '@real-life/trust-protocol'
import { CHALLENGE_MAX_AGE } from '@real-life/trust-protocol'
import type { ConversationKey, DeliveryState, SystemKind } from '../../port'
import type { EncounterCache, Ledger, LogLine, MessageLine } from './app-data'
import { encodeCardLink } from './card-link'

export interface IngestInput {
  readonly commitSeq: string
  readonly now: number
  readonly events: readonly HolderEvent[]
  readonly contacts: readonly ContactView[]
  readonly prompts: readonly PromptView[]
  readonly encounters: EncounterCache
  readonly ledger: Ledger
  /** the inbox at the fence (Message Tasks 4.5) */
  readonly inbox: readonly InboxMessageView[]
  /** own sent messages whose status is not final, with their sender status at the fence */
  readonly statuses: readonly { readonly line: MessageLine; readonly items: readonly DeliveryItemView[] }[]
}

export interface IngestOutput {
  readonly encounters: EncounterCache
  readonly ledger: Ledger
  readonly lines: readonly LogLine[]
  /** inbox ids to hand back with takeMessages once the lines are written (the app took them over) */
  readonly take: readonly string[]
}

/** The sender status of one own document (Delivery §6.1) as the port's DeliveryState. */
export function deliveryOf(items: readonly DeliveryItemView[]): DeliveryState | null {
  const it = items[0]
  if (!it) return null
  if (it.awaiting) return { phase: 'queued', reason: it.awaiting === 'offline' ? 'offline' : it.awaiting === 'transport-unreachable' ? 'transport-unreachable' : 'carrier-retry' }
  switch (it.status) {
    case 'submitted':
      return { phase: 'submitted' }
    case 'accepted':
      return { phase: 'accepted' }
    case 'delivered':
      return { phase: 'delivered', late: it.late === true }
    case 'failed': {
      const reason = it.reason === 'unroutable' ? 'unroutable' : it.reason === 'oversize' ? 'oversize' : it.reason === 'rejected-by-receiver' ? 'rejected' : 'expired'
      // a failed document is never sent again by the core (no controlled retry in 0.6.1, §2.7 N11)
      return { phase: 'failed', reason, retry: { ok: false, reason: 'not-supported' } }
    }
    default:
      return { phase: 'submitted' }
  }
}

/** Whether an own message's status can still change (failed can turn into delivered on a late ack). */
export const statusFinal = (s: DeliveryState | null): boolean => s?.phase === 'delivered'

const DAY = 86_400_000
/** the conversation key of messages whose relationship departed: kept, shown in no conversation */
export const DEPARTED = '-departed'

/** What the encounter cache learns from events (own acts and taken-over commits alike); pure and
 *  idempotent, so an own act can apply its events in the transaction that finishes its intent
 *  (§3.4 step 4, N4) and the next sync can apply them again without harm. */
export function applyEncounterEvents(
  cache: EncounterCache,
  events: readonly HolderEvent[],
  now: number,
  captured?: { anchor: string },
): Required<EncounterCache> & { recorded: Set<string>; chained: Set<string> } {
  const own: Record<string, EncounterCache['own'][string]> = { ...cache.own }
  const sent: Record<string, EncounterCache['sent'][string]> = { ...cache.sent }
  const met: Record<string, EncounterCache['met'][string]> = { ...cache.met }
  const capturedBy: Record<string, string> = { ...(cache.capturedBy ?? {}) }
  const recorded = new Set<string>()
  const chained = new Set<string>()
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
  // an optical capture records which sent card made which contact (a second capture of the same card
  // reports nothing new; this maps it back, N9)
  const rec = events.find((e) => e.type === 'encounter.recorded')
  if (captured && rec && rec.type === 'encounter.recorded') capturedBy[captured.anchor] = rec.contactId
  return { own, sent, met, capturedBy, recorded, chained }
}

export function ingest(input: IngestInput): IngestOutput {
  const { now, events, commitSeq } = input
  const applied = applyEncounterEvents(input.encounters, events, now)
  const own: Record<string, EncounterCache['own'][string]> = { ...applied.own }
  const sent: Record<string, EncounterCache['sent'][string]> = { ...applied.sent }
  const met = applied.met
  const { recorded, chained } = applied
  const lines: LogLine[] = []
  const line = (contactId: string, system: SystemKind, basis: 'event' | 'observed', at = now): void => {
    const key: ConversationKey = `c:${contactId}`
    lines.push({ kind: 'system', id: `sys:${contactId}:${commitSeq}:${system}`, key, at, system, basis })
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

  // inbox take-over (4420): every accepted entry goes into the history before it is taken, also one
  // whose relationship is blocked now (accepted before the block; the projection hides it while the
  // block holds, 6230) and one whose relationship departed (kept, shown nowhere) (review 421 R1-3)
  const take: string[] = []
  for (const m of input.inbox) {
    take.push(m.id)
    lines.push({
      kind: 'message',
      id: `msg:in:${m.id}`,
      key: `c:${m.contactId ?? DEPARTED}`,
      at: m.displayAt,
      dir: 'in',
      contactId: m.contactId ?? DEPARTED,
      text: m.text,
      mid: m.mid,
      replyTo: m.replyTo ?? null,
      sentAt: m.sentAt,
      receivedAt: m.receivedAt,
      digest: null,
      draftKey: null,
      held: null,
      status: null,
    })
  }
  for (const { line, items } of input.statuses) {
    const status = deliveryOf(items)
    // the sender time the core put on the document: its submission, in whole seconds (Message Tasks
    // 3030); the act's own time can be earlier than the core's monotone time (review 421 R1-5)
    const submitted = items[0]?.submittedAt
    const sentAt = submitted ? Math.floor(submitted / 1000) * 1000 : line.sentAt
    if ((status && JSON.stringify(status) !== JSON.stringify(line.status)) || sentAt !== line.sentAt) lines.push({ ...line, status: status ?? line.status, sentAt, at: sentAt })
  }

  return { encounters: { own, sent, met, capturedBy: applied.capturedBy }, ledger: { contacts: ledgerContacts, prompts: ledgerPrompts }, lines, take }
}
