// Projection (architecture §3.1 "Projektion"): pure, one consistent bundle → the port's read models.
// The library's views and the app-db part come from the same fence (session.ts); this function only
// maps. Structural sharing happens in the port's stores (writableStore).

import type { ContactView, ProfileView, PromptView } from '@real-life/trust-protocol'
import type {
  Availability,
  BlockedEntry,
  ContactActions,
  ContactDetail,
  ContactId,
  ContactListItem,
  Conversation,
  ConversationItem,
  ConversationKey,
  ConversationPreview,
  ConversationSummary,
  Decision,
  DecisionId,
  DecisionResolution,
  IntentView,
  MessageId,
  MessageItem,
  ProfileModel,
  Revision,
  TrustStandingSummary,
  VisibilityEntry,
} from '../../port'
import { compareOrder, orderKey, type EncounterCache, type LogLine, type MessageLine, type ReadMarks } from './app-data'
import { DEPARTED } from './ingest'
import { isOpen, type IntentRecord } from './journal'

export interface ProjectionInput {
  readonly revision: Revision
  readonly now: number
  readonly timeZone: string
  readonly anchorShort: string
  readonly contacts: readonly ContactView[]
  readonly prompts: readonly PromptView[]
  readonly profile: ProfileView
  readonly encounters: EncounterCache
  readonly lines: readonly LogLine[]
  readonly intents: readonly IntentRecord[]
  readonly reads: ReadMarks
}

export interface ReadModels {
  readonly revision: Revision
  readonly contacts: readonly ContactListItem[]
  readonly contactDetails: ReadonlyMap<string, ContactDetail>
  readonly conversations: ReadonlyMap<ConversationKey, Conversation>
  readonly decisions: readonly Decision[]
  readonly profile: ProfileModel
  readonly standing: TrustStandingSummary
  readonly visibility: readonly VisibilityEntry[]
  readonly blocked: readonly BlockedEntry[]
  readonly intents: readonly IntentView[]
}

const NO = (reason: Exclude<Availability, { ok: true }>['reason']): Availability => ({ ok: false, reason })
const OK: Availability = { ok: true }

export function localDay(at: number, timeZone: string): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(at)
}

/** running intents per target, for in-flight availability */
function runningTargets(intents: readonly IntentRecord[]): Set<string> {
  const s = new Set<string>()
  for (const r of intents) if (r.state === 'journaled' || r.state === 'running') s.add(`${r.command}|${r.target}`)
  return s
}

function decisionOf(p: PromptView, running: Set<string>): Decision | null {
  const base = {
    id: p.id as DecisionId,
    openedAt: p.openedAt,
    expiresAt: p.expiresAt ?? null,
    state: running.has(`decide|${p.id}`) || (p.contactId !== undefined && running.has(`counterVerify|c:${p.contactId}`)) ? ('in-flight' as const) : ('open' as const),
  }
  if (p.kind === 'encounter-confirm' && p.contactId !== undefined) return { ...base, kind: 'encounter-confirm', contactId: p.contactId as ContactId }
  // group invitations, vouches and introductions come with their screens (not in this step)
  return null
}

/** A decision that is no longer open: what this device decided (its finished intent names the
 *  prompt in `decided`), else unknown (N5: a vanished prompt proves neither choice nor actor). */
function resolutionOf(decision: string, line: LogLine, intents: readonly IntentRecord[]): DecisionResolution {
  if (line.kind === 'decision' && line.resolution) return line.resolution
  for (const r of intents) {
    const v = r.outcome?.ok === true ? (r.outcome.value as { decided?: { prompt: string; choice: 'accept' | 'decline' } } | null) : null
    if (v?.decided?.prompt === decision) return { choice: v.decided.choice, by: 'this-device', at: r.finishedAt ?? r.when, basis: 'own-act' }
  }
  return { choice: 'unknown', by: 'unknown', at: line.at, basis: 'observed' }
}

function preview(items: readonly ConversationItem[], decisions: ReadonlyMap<string, Decision>, names: ReadonlyMap<string, string | null>): ConversationPreview | null {
  for (let i = items.length - 1; i >= 0; i--) {
    const item = items[i]
    if (!item || item.kind === 'day') continue
    if (item.kind === 'message') return { kind: 'message', authorLabel: item.author, text: item.text, at: item.at }
    if (item.kind === 'system') return { kind: 'system', authorLabel: null, text: '', i18n: { key: item.system, values: {} }, at: item.at }
    const d = decisions.get(item.decision)
    if (d && item.resolution === null && d.kind === 'encounter-confirm') {
      return { kind: 'decision', authorLabel: null, text: '', i18n: { key: d.kind, values: { name: names.get(d.contactId) ?? '' } }, at: item.at }
    }
  }
  return null
}

/** when this device saw the block (its system line), else 0 */
function blockedSince(lines: readonly LogLine[], contactId: string): number {
  let at = 0
  for (const l of lines) if (l.kind === 'system' && l.system === 'blocked' && l.key === `c:${contactId}` && l.at > at) at = l.at
  return at
}

function authorOf(l: MessageLine, names: ReadonlyMap<string, string | null>) {
  return l.dir === 'out' ? ({ kind: 'self' } as const) : ({ kind: 'contact', contactId: l.contactId as ContactId, name: names.get(l.contactId) ?? null } as const)
}

function messageItem(l: MessageLine, byMid: ReadonlyMap<string, MessageLine>, names: ReadonlyMap<string, string | null>): MessageItem {
  // replyTo names a mid of this relationship (Message Tasks 3.2); shown only when the app holds an
  // earlier message with it in this conversation, otherwise the reference is dropped
  const ref = l.replyTo !== null ? byMid.get(l.replyTo) : undefined
  // a mid is random, not causal: any other message of this relationship that the app holds counts,
  // whatever order the display gives them within a second (review 421 R2-5)
  const replyTo = ref && ref !== l ? { id: ref.id as MessageId, author: authorOf(ref, names), text: ref.text } : undefined
  return {
    kind: 'message',
    id: l.id as MessageId,
    author: authorOf(l, names),
    text: l.text,
    at: l.at,
    origin: l.dir === 'out' ? 'this-device' : 'received',
    sentAt: l.sentAt,
    receivedAt: l.receivedAt,
    delivery: l.dir === 'out' ? (l.held ? { phase: 'held', reason: l.held } : (l.status ?? { phase: 'submitted' })) : null,
    signed: l.dir === 'in',
    selectableForReport: l.dir === 'in',
    ...(replyTo ? { replyTo } : {}),
  }
}

export function project(input: ProjectionInput): ReadModels {
  const running = runningTargets(input.intents)
  const decisions: Decision[] = []
  for (const p of input.prompts) {
    const d = decisionOf(p, running)
    if (d) decisions.push(d)
  }
  const decisionById = new Map<string, Decision>(decisions.map((d) => [d.id, d]))
  const names = new Map<string, string | null>(input.contacts.map((c) => [c.id, c.displayName ?? null]))

  // own messages still being committed come from the journal (§2.7 "laufender Zustand")
  const lines: LogLine[] = [...input.lines]
  const have = new Set(lines.map((l) => l.id))
  for (const r of input.intents) {
    if (r.command !== 'send' || !(r.state === 'journaled' || r.state === 'running' || r.state === 'outcome-unknown') || !r.input) continue
    const id = `msg:out:${String(r.input.draftKey)}`
    if (have.has(id)) continue
    lines.push({
      kind: 'message', id, key: `c:${String(r.input.contactId)}`, at: r.when, dir: 'out', contactId: String(r.input.contactId), text: String(r.input.text),
      mid: null, replyTo: null, sentAt: r.when, receivedAt: null, digest: null, draftKey: String(r.input.draftKey), held: null,
      // an open outcome is repeated on its own with the same act (20.10.): the user sees it sending
      status: { phase: 'committing' },
    })
  }

  // conversation lines per key, chronological, day dividers inserted
  const byKey = new Map<ConversationKey, LogLine[]>()
  for (const l of lines) {
    const list = byKey.get(l.key) ?? []
    list.push(l)
    byKey.set(l.key, list)
  }
  const contactById = new Map(input.contacts.map((c) => [c.id, c] as const))
  const conversations = new Map<ConversationKey, Conversation>()
  const summaries = new Map<ConversationKey, ConversationSummary>()
  // messages of departed relationships stay in the history but in no conversation
  const keys = new Set<ConversationKey>([...input.contacts.map((c) => `c:${c.id}` as const), ...[...byKey.keys()].filter((k) => k !== `c:${DEPARTED}`)])
  for (const key of keys) {
    // chronological (messages by display time, then mid, Message Tasks 4430); at the same instant the
    // system line (what happened) before the decision it opened, and both before messages
    const sorted = [...(byKey.get(key) ?? [])].sort((a, b) => compareOrder(orderKey(a), orderKey(b)))
    const contactId = key.startsWith('c:') ? key.slice(2) : null
    const contact = contactId !== null ? contactById.get(contactId) : undefined
    // blocked: nothing of the contact's content is shown (Message Tasks 6230)
    const visible = contact?.blocked ? sorted.filter((l) => l.kind !== 'message' || l.dir === 'out') : sorted
    const byMid = new Map<string, MessageLine>()
    for (const l of visible) if (l.kind === 'message' && l.mid !== null) byMid.set(l.mid, l)
    const mark = input.reads[key]
    const items: ConversationItem[] = []
    let day: string | null = null
    let openDecisions = 0
    let unread = 0
    for (const l of visible) {
      const d = localDay(l.at, input.timeZone)
      if (d !== day) {
        day = d
        items.push({ kind: 'day', id: `day:${d}`, day: d })
      }
      if (l.kind === 'system') {
        items.push({ kind: 'system', id: l.id, system: l.system, at: l.at, basis: l.basis, ...(l.subject ? { subject: l.subject as ContactId } : {}) })
      } else if (l.kind === 'decision') {
        const open = decisionById.has(l.decision)
        if (open) openDecisions++
        items.push({ kind: 'decision', id: l.id, decision: l.decision as DecisionId, at: l.at, resolution: open ? null : resolutionOf(l.decision, l, input.intents) })
      } else {
        items.push(messageItem(l, byMid, names))
        if (l.dir === 'in' && (!mark || compareOrder(orderKey(l), mark) > 0)) unread++
      }
    }
    conversations.set(key, {
      key,
      title: contact ? (contact.displayName ?? null) : null,
      items,
      hasEarlier: false,
      composer: !contact ? NO('not-supported') : contact.blocked ? NO('blocked') : OK,
    })
    const last = visible.at(-1)
    summaries.set(key, { key, preview: preview(items, decisionById, names), unread, openDecisions, lastActivityAt: last ? last.at : null, muted: false })
  }

  const contactDetails = new Map<string, ContactDetail>()
  const contacts: ContactListItem[] = input.contacts.map((c) => {
    const key: ConversationKey = `c:${c.id}`
    const summary = {
      id: c.id as ContactId,
      name: c.displayName ?? null,
      image: c.profile?.image ?? null,
      verification: c.provenance === 'introduced' && c.verification === 'met' ? ('introduced' as const) : c.verification,
      trust: { ...c.trust },
      blocked: c.blocked,
    }
    const counterRunning = running.has(`counterVerify|${key}`)
    const actions: ContactActions = {
      counterVerify: c.verification !== 'incoming' ? NO('already-done') : counterRunning ? NO('in-flight') : OK,
      verifyAgain: OK,
      giveTrust: NO('not-supported'),
      withdrawTrust: NO('not-supported'),
      pause: NO('not-supported'),
      invite: NO('not-supported'),
      introduce: NO('later'),
      report: OK,
      block: c.blocked ? NO('already-done') : running.has(`block|${key}`) ? NO('in-flight') : OK,
      unblock: !c.blocked ? NO('already-done') : running.has(`unblock|${key}`) ? NO('in-flight') : OK,
      remove: NO('not-supported'),
    }
    const met = input.encounters.met[c.id]
    contactDetails.set(c.id, {
      ...summary,
      introducedBy: (c.via ?? null) as ContactId | null,
      metAt: met?.metAt ?? null,
      lastMetAt: met?.lastMetAt ?? null,
      sharedGroups: null,
      actions,
    })
    const conversation = summaries.get(key) ?? { key, preview: null, unread: 0, openDecisions: 0, lastActivityAt: null, muted: false }
    return { ...summary, conversation }
  })
  contacts.sort((a, b) => (b.conversation.lastActivityAt ?? 0) - (a.conversation.lastActivityAt ?? 0) || (a.name ?? '').localeCompare(b.name ?? '') || (a.id < b.id ? -1 : 1))

  // open intents only; a showCard (policy discard) is never shown: a new card needs a new gesture
  const intents: IntentView[] = input.intents
    .filter((r): r is IntentRecord & { state: Exclude<IntentRecord['state'], 'done'> } => isOpen(r) && r.policy !== 'discard')
    .map((r) => ({
      actId: r.actId,
      command: r.command,
      target: r.target,
      state: r.state,
      since: r.createdAt,
      retry: r.policy === 'replay' && (r.state === 'outcome-unknown' || r.state === 'partial') ? OK : NO('not-supported'),
      ...(r.state === 'needs-confirmation' && r.preview ? { confirm: { kind: 'card' as const, preview: r.preview } } : {}),
    }))

  return {
    revision: input.revision,
    contacts,
    contactDetails,
    conversations,
    decisions,
    profile: { name: input.profile.name ?? null, image: input.profile.image ?? null, anchorShort: input.anchorShort, pending: false },
    standing: {
      trustYou: input.contacts.filter((c) => c.trust.received).length,
      youTrust: input.contacts.filter((c) => c.trust.given).length,
      mutuallyVerified: input.contacts.filter((c) => c.verification === 'mutual').length,
      groups: 0,
    },
    visibility: input.contacts.filter((c) => c.trust.given).map((c) => ({ contactId: c.id as ContactId, name: c.displayName ?? null, paused: c.trust.paused })),
    blocked: input.contacts
      .filter((c) => c.blocked)
      .map((c) => ({ target: { kind: 'contact' as const, contactId: c.id as ContactId }, label: c.displayName ?? '', since: blockedSince(input.lines, c.id) })),
    intents,
  }
}
