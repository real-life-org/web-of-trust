// Pure projection: simulated world state → port read models (one bundle, one revision).

import type {
  AuthorLabel,
  BlockedEntry,
  Availability,
  Candidacy,
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
  DeliveryState,
  GroupId,
  GroupListItem,
  MemberRef,
  MessageId,
  ProfileModel,
  ReportStatus,
  Revision,
  TrustStandingSummary,
  VisibilityEntry,
} from '../../port'
import type { ContactSeed, DecisionSeed, GroupSeed, PersonSeed, SeedItem } from './seed'

/** A seeded item with its time parsed and a stable id. */
export type WorldItem = SeedItem & { readonly id: string; readonly atMs: number }

export interface WorldState {
  readonly me: { readonly name: string; readonly anchorShort: string }
  readonly persons: ReadonlyMap<string, PersonSeed>
  readonly contacts: readonly ContactSeed[]
  readonly groups: readonly GroupSeed[]
  readonly conversations: ReadonlyMap<ConversationKey, readonly WorldItem[]>
  readonly decisions: readonly DecisionSeed[]
  readonly candidacies: readonly Candidacy[]
  /** index of the last item read per conversation (-1: nothing read) */
  readonly readThrough: ReadonlyMap<ConversationKey, number>
}

export interface Bundle {
  readonly revision: Revision
  readonly contacts: readonly ContactListItem[]
  readonly contactDetails: ReadonlyMap<string, ContactDetail>
  readonly groups: readonly GroupListItem[]
  readonly decisions: readonly Decision[]
  readonly conversations: ReadonlyMap<ConversationKey, Conversation>
  readonly candidacies: readonly Candidacy[]
  readonly profile: ProfileModel
  readonly standing: TrustStandingSummary
  readonly visibility: readonly VisibilityEntry[]
  readonly blocked: readonly BlockedEntry[]
  readonly reports: readonly ReportStatus[]
}

const NOT_SUPPORTED: Availability = { ok: false, reason: 'not-supported' }

/** YYYY-MM-DD of an instant in a time zone. */
export function localDay(at: number, timeZone: string): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(at)
}

function delivery(status: 'sending' | 'sent' | 'delivered' | 'held' | 'failed' | 'expired' | undefined): DeliveryState | null {
  switch (status) {
    case 'held':
      return { phase: 'held', reason: 'not-ready' }
    case 'failed':
      return { phase: 'failed', reason: 'expired', retry: { ok: false, reason: 'not-supported' } }
    case 'expired':
      return { phase: 'expired' }
    case 'sending':
      return { phase: 'committing' }
    case 'sent':
      return { phase: 'accepted' }
    case 'delivered':
      return { phase: 'delivered', late: false }
    default:
      return null
  }
}

function author(state: WorldState, from: string): AuthorLabel {
  if (from === 'me') return { kind: 'self' }
  if (from.startsWith('member:')) {
    const handle = from.slice('member:'.length)
    return { kind: 'member', handle, member: `member:${handle}` as MemberRef }
  }
  return { kind: 'contact', contactId: from as ContactId, name: state.persons.get(from)?.name ?? null }
}

function decisionOf(seed: DecisionSeed): Decision {
  const base = { id: seed.id as DecisionId, openedAt: Date.parse(seed.openedAt), expiresAt: null, state: 'open' as const }
  switch (seed.kind) {
    case 'encounter-confirm':
      return { ...base, kind: 'encounter-confirm', contactId: seed.contact as ContactId }
    case 'group-invite':
      return {
        ...base,
        kind: 'group-invite',
        inviterId: seed.inviter as ContactId,
        groupName: seed.groupName,
        candidacyChoice: NOT_SUPPORTED,
      }
    case 'vouch':
      return {
        ...base,
        kind: 'vouch',
        groupId: seed.group as GroupId,
        member: seed.member as MemberRef,
        memberName: seed.memberName,
        have: seed.have,
        need: seed.need,
      }
  }
}

function decisionPreviewValues(state: WorldState, d: Decision): Record<string, string> {
  switch (d.kind) {
    case 'encounter-confirm':
      return { name: state.persons.get(d.contactId)?.name ?? '' }
    case 'group-invite':
      return { name: state.persons.get(d.inviterId)?.name ?? '', group: d.groupName ?? '' }
    case 'vouch':
      return { name: d.memberName ?? '', have: String(d.have), need: String(d.need) }
    case 'introduction':
      return { name: state.persons.get(d.introducerId)?.name ?? '', label: d.label ?? '' }
  }
}

function itemsOf(state: WorldState, key: ConversationKey, timeZone: string, open: ReadonlySet<string>): ConversationItem[] {
  const out: ConversationItem[] = []
  let day: string | null = null
  for (const item of state.conversations.get(key) ?? []) {
    const d = localDay(item.atMs, timeZone)
    if (d !== day) {
      day = d
      out.push({ kind: 'day', id: `day:${d}`, day: d })
    }
    switch (item.t) {
      case 'msg': {
        const mine = item.from === 'me'
        const ref = item.replyTo !== undefined ? (state.conversations.get(key) ?? [])[item.replyTo] : undefined
        out.push({
          ...(ref && ref.t === 'msg' ? { replyTo: { id: ref.id as MessageId, author: author(state, ref.from), text: ref.text } } : {}),
          kind: 'message',
          id: item.id as MessageId,
          author: author(state, item.from),
          text: item.text,
          at: item.atMs,
          origin: mine ? 'this-device' : 'received',
          delivery: mine ? delivery(item.status) : null,
          signed: !mine,
          selectableForReport: !mine,
        })
        break
      }
      case 'sys':
        out.push({
          kind: 'system',
          id: item.id,
          system: item.system,
          at: item.atMs,
          basis: item.basis ?? 'event',
          ...(item.values ? { values: item.values } : {}),
        })
        break
      case 'decision':
        out.push({
          kind: 'decision',
          id: item.id,
          decision: item.decision as DecisionId,
          at: item.atMs,
          resolution: open.has(item.decision) ? null : { choice: 'unknown', by: 'unknown', at: item.atMs, basis: 'observed' },
        })
        break
    }
  }
  return out
}

/** Received messages after the read mark. */
export function unreadOf(state: WorldState, key: ConversationKey): number {
  const items = state.conversations.get(key) ?? []
  const through = state.readThrough.get(key) ?? items.length - 1
  let n = 0
  for (let i = through + 1; i < items.length; i++) {
    const item = items[i]
    if (item?.t === 'msg' && item.from !== 'me') n++
  }
  return n
}

function summaryOf(
  state: WorldState,
  key: ConversationKey,
  items: readonly ConversationItem[],
  decisions: ReadonlyMap<string, Decision>,
): ConversationSummary {
  let preview: ConversationPreview | null = null
  let lastActivityAt: number | null = null
  let openDecisions = 0
  for (const item of items) {
    if (item.kind === 'day') continue
    lastActivityAt = Math.max(lastActivityAt ?? 0, item.at)
    if (item.kind === 'decision' && item.resolution === null) openDecisions++
    if (item.kind === 'message') {
      preview = { kind: 'message', authorLabel: item.author, text: item.text, at: item.at }
    } else if (item.kind === 'system') {
      preview = {
        kind: 'system',
        authorLabel: null,
        text: '',
        i18n: { key: item.system, values: Object.fromEntries(Object.entries(item.values ?? {}).map(([k, v]) => [k, String(v)])) },
        at: item.at,
      }
    } else {
      const d = decisions.get(item.decision)
      if (d) preview = { kind: 'decision', authorLabel: null, text: '', i18n: { key: d.kind, values: decisionPreviewValues(state, d) }, at: item.at }
    }
  }
  return { key, preview, unread: unreadOf(state, key), openDecisions, lastActivityAt, muted: false }
}

const ACTIONS: ContactActions = {
  counterVerify: NOT_SUPPORTED,
  verifyAgain: NOT_SUPPORTED,
  giveTrust: NOT_SUPPORTED,
  withdrawTrust: NOT_SUPPORTED,
  pause: NOT_SUPPORTED,
  invite: NOT_SUPPORTED,
  introduce: { ok: false, reason: 'later' },
  report: NOT_SUPPORTED,
  block: NOT_SUPPORTED,
  unblock: NOT_SUPPORTED,
  remove: NOT_SUPPORTED,
}

/** Sort: most recent activity first; stable by name. */
function byActivity<T extends { conversation: ConversationSummary; name: string | null }>(a: T, b: T): number {
  const d = (b.conversation.lastActivityAt ?? 0) - (a.conversation.lastActivityAt ?? 0)
  return d !== 0 ? d : (a.name ?? '').localeCompare(b.name ?? '')
}

export function project(state: WorldState, rev: Revision, timeZone: string): Bundle {
  const decisions = state.decisions.map(decisionOf)
  const decisionById = new Map(decisions.map((d) => [d.id as string, d]))
  const open = new Set(decisionById.keys())

  const conversations = new Map<ConversationKey, Conversation>()
  const summaries = new Map<ConversationKey, ConversationSummary>()
  const titles = new Map<ConversationKey, string | null>()
  for (const c of state.contacts) titles.set(`c:${c.person}`, state.persons.get(c.person)?.name ?? null)
  for (const g of state.groups) titles.set(`g:${g.id}`, g.name)
  for (const key of new Set([...titles.keys(), ...state.conversations.keys()])) {
    const items = itemsOf(state, key, timeZone, open)
    conversations.set(key, {
      key,
      title: titles.get(key) ?? null,
      items,
      hasEarlier: false,
      composer: NOT_SUPPORTED,
    })
    summaries.set(key, summaryOf(state, key, items, decisionById))
  }

  const contactDetails = new Map<string, ContactDetail>()
  const contacts: ContactListItem[] = state.contacts.map((c) => {
    const key: ConversationKey = `c:${c.person}`
    const summary = {
      id: c.person as ContactId,
      name: state.persons.get(c.person)?.name ?? null,
      image: null,
      verification: c.verification,
      trust: { given: c.trust.given, received: c.trust.received, paused: c.trust.paused ?? false, pending: false },
      blocked: c.blocked ?? false,
    }
    const metAt = c.metAt === null ? null : Date.parse(c.metAt)
    contactDetails.set(c.person, {
      ...summary,
      introducedBy: (c.introducedBy ?? null) as ContactId | null,
      metAt,
      lastMetAt: metAt,
      sharedGroups: null,
      actions: ACTIONS,
    })
    return { ...summary, conversation: summaries.get(key) ?? summaryOf(state, key, [], decisionById) }
  })
  contacts.sort(byActivity)

  const groups: GroupListItem[] = state.groups.map((g) => {
    const key: ConversationKey = `g:${g.id}`
    return {
      id: g.id as GroupId,
      name: g.name,
      role: g.role,
      knownMembers: g.knownMembers,
      myHandle: g.myHandle,
      openAdmissions: g.openAdmissions,
      conversation: summaries.get(key) ?? summaryOf(state, key, [], decisionById),
    }
  })
  groups.sort(byActivity)

  return {
    revision: rev,
    contacts,
    contactDetails,
    groups,
    decisions,
    conversations,
    candidacies: state.candidacies,
    profile: { name: state.me.name, image: null, anchorShort: state.me.anchorShort, pending: false },
    standing: {
      trustYou: state.contacts.filter((c) => c.trust.received).length,
      youTrust: state.contacts.filter((c) => c.trust.given).length,
      mutuallyVerified: state.contacts.filter((c) => c.verification === 'mutual').length,
      groups: state.groups.length,
    },
    visibility: state.contacts
      .filter((c) => c.trust.given)
      .map((c) => ({
        contactId: c.person as ContactId,
        name: state.persons.get(c.person)?.name ?? null,
        paused: c.trust.paused ?? false,
      })),
    blocked: [],
    reports: [],
  }
}
