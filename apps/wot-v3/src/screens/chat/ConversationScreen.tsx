// A 1:1 conversation (design: isChat). The head opens the contact details (messenger pattern);
// an open encounter-confirm card opens the counter sheet. Group conversations follow.
import { useState } from 'react'
import type { ContactId, ConversationItem, ConversationKey, Decision, DeliveryState, MessageItem } from '../../port'
import { useContact, useContacts, useConversation, useDecisions, useFormat, useNav } from '../../hooks'
import { useI18n, type I18n } from '../../i18n'
import {
  CenteredNote,
  ChatHeader,
  Composer,
  DECISION_GLYPH,
  DayDivider,
  DecisionCard,
  MessageBubble,
  SYSTEM_GLYPH,
  SystemLine,
  ThreadScroller,
} from '../../ui/components'
import { CounterSheet } from '../contacts/CounterSheet'

function firstName(name: string): string {
  return name.split(' ')[0] ?? name
}

function deliveryWord(d: DeliveryState | null, { t, f }: I18n): string | null {
  if (d === null) return null
  switch (d.phase) {
    case 'committing':
    case 'submitted':
      return t.delivery.sending
    case 'queued':
      return t.delivery.waitingForNetwork
    case 'accepted':
      return `${t.delivery.sent} ✓`
    case 'delivered':
      return `${t.delivery.delivered} ✓✓`
    case 'partial':
      return f(t.delivery.partial, { delivered: d.delivered, of: d.of })
    case 'failed':
      return t.delivery.failed
  }
}

function authorKey(m: MessageItem): string {
  const a = m.author
  return a.kind === 'self' ? 'self' : a.kind === 'contact' ? `c:${a.contactId}` : `m:${a.handle}`
}

function decisionTexts(d: Decision, names: ReadonlyMap<string, string>, { t, f }: I18n) {
  const name = (id: string) => names.get(id) ?? t.contacts.unnamed
  switch (d.kind) {
    case 'encounter-confirm': {
      const x = t.decision['encounter-confirm']
      return { kind: x.kind, title: f(x.title, { name: name(d.contactId) }), sub: x.sub, cta: x.cta }
    }
    case 'group-invite': {
      const x = t.decision['group-invite']
      const inviter = name(d.inviterId)
      return {
        kind: x.kind,
        title: d.groupName === null ? f(x.titleUnknown, { name: inviter }) : f(x.title, { group: d.groupName }),
        sub: f(x.sub, { name: inviter }),
        cta: x.cta,
      }
    }
    case 'vouch': {
      const x = t.decision.vouch
      const missing = d.need - d.have
      const values = { name: d.memberName ?? t.contacts.unnamed, have: d.have, need: d.need, missing }
      return { kind: x.kind, title: f(x.title, values), sub: f(missing === 1 ? x.subOneMissing : x.sub, values), cta: x.cta }
    }
    case 'introduction': {
      const x = t.decision.introduction
      return { kind: x.kind, title: f(x.title, { name: name(d.introducerId), label: d.label ?? '' }), sub: x.sub, cta: x.cta }
    }
  }
}

export function ConversationScreen({ conversationKey }: { conversationKey: ConversationKey }) {
  const i18n = useI18n()
  const { t, f } = i18n
  const fmt = useFormat()
  const { send } = useNav()
  const conversation = useConversation(conversationKey)
  const contactId = (conversationKey.startsWith('c:') ? conversationKey.slice(2) : '') as ContactId
  const contact = useContact(contactId)
  const contacts = useContacts()
  const decisions = useDecisions()
  const [counterFor, setCounterFor] = useState<ContactId | null>(null)

  if (conversation.status !== 'ready') {
    return <CenteredNote text={conversation.status === 'loading' ? t.shell.loading : t.chat.notFound} />
  }
  const c = conversation.value
  const detail = contact.status === 'ready' ? contact.value : null
  const name = c.title ?? t.contacts.unnamed
  const names = new Map<string, string>(
    contacts.status === 'ready' ? contacts.value.map((x) => [x.id, x.name ?? t.contacts.unnamed] as const) : [],
  )
  const openDecisions = new Map<string, Decision>(decisions.status === 'ready' ? decisions.value.map((d) => [d.id, d] as const) : [])

  const messages = c.items
  const render = (item: ConversationItem, i: number) => {
    switch (item.kind) {
      case 'day':
        return <DayDivider key={item.id} label={fmt.dayLabel(item.day)} />
      case 'system': {
        const g = SYSTEM_GLYPH[item.system]
        const values = { name: item.subject ? (names.get(item.subject) ?? '') : '', ...item.values }
        return <SystemLine key={item.id} glyph={g.glyph} tone={g.tone} text={f(t.system[item.system], values)} />
      }
      case 'decision': {
        const d = openDecisions.get(item.decision)
        if (!d || item.resolution !== null) {
          return <SystemLine key={item.id} glyph="·" tone="muted" text={t.decision.resolved} />
        }
        const g = DECISION_GLYPH[d.kind]
        const onAction = d.kind === 'encounter-confirm' && d.state === 'open' ? () => setCounterFor(d.contactId) : undefined
        return <DecisionCard key={item.id} glyph={g.glyph} tone={g.tone} resolved={null} {...decisionTexts(d, names, i18n)} {...(onAction ? { onAction } : {})} />
      }
      case 'message': {
        const prev = messages[i - 1]
        const next = messages[i + 1]
        const runStart = !(prev?.kind === 'message' && authorKey(prev) === authorKey(item))
        const lastOfRun = !(next?.kind === 'message' && authorKey(next) === authorKey(item))
        const mine = item.author.kind === 'self'
        const word = mine ? deliveryWord(item.delivery, i18n) : null
        const time = fmt.time(item.at)
        return (
          <MessageBubble
            key={item.id}
            mine={mine}
            text={item.text}
            runStart={runStart}
            meta={lastOfRun ? (word ? `${time} · ${word}` : time) : null}
            metaStrong={item.delivery?.phase === 'delivered'}
          />
        )
      }
    }
  }

  const first = firstName(name)
  return (
    <>
      <ChatHeader
        name={name}
        {...(detail ? { verification: detail.verification, trust: detail.trust } : {})}
        onBack={() => send({ type: 'back' })}
        {...(detail ? { onDetails: () => send({ type: 'push', route: { kind: 'contact', id: detail.id } }) } : {})}
      />
      <ThreadScroller>{messages.map(render)}</ThreadScroller>
      <Composer
        placeholder={f(t.chat.messageTo, { name: first })}
        note={detail?.verification === 'outgoing' ? f(t.chat.notOnlineYet, { name: first }) : null}
        lockedReason={c.composer.ok ? null : t.chat.composerLocked}
      />
      {counterFor ? <CounterSheet contactId={counterFor} name={names.get(counterFor) ?? t.contacts.unnamed} open onClose={() => setCounterFor(null)} /> : null}
    </>
  )
}
