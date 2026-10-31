// Contacts tab: messenger list of contacts with their conversation (design: tab "contacts"). Alone (the
// desktop without a second column, canvas "Leer"): an empty list is a centered empty state that carries
// "Verify in person" itself.
import { useRef, useState } from 'react'
import type { ContactId } from '../../port'
import { useConnectivity, useContacts, useFormat, useNav } from '../../hooks'
import { Button, Switch } from '../../ui/primitives'
import { useI18n } from '../../i18n'
import {
  CenteredNote,
  ConversationRow,
  EmptyState,
  FooterAction,
  ListHeader,
  PersonIcon,
  TransportLine,
  VerifyIcon,
  previewText,
} from '../../ui/components'
import { InterruptedEncounters } from './InterruptedEncounters'
import { TrustSheet } from './TrustSheet'

export function ContactListScreen({ alone = false }: { alone?: boolean }) {
  const i18n = useI18n()
  const { t, f } = i18n
  const contacts = useContacts()
  const connectivity = useConnectivity()
  const { state, send } = useNav()
  const fmt = useFormat()
  const first = state.stack[0]
  const selected = first?.kind === 'chat' ? first.key : null
  const verify = () => send({ type: 'push', route: { kind: 'verify' } })
  const empty = contacts.status === 'ready' && contacts.value.length === 0
  // the trust button of a row opens the same question as the detail's switch (TrustSheet)
  const [trustFor, setTrustFor] = useState<{ id: ContactId; name: string; mode: 'on' | 'off' } | null>(null)
  const listRef = useRef<HTMLDivElement | null>(null)

  return (
    <>
      <ListHeader title={t.nav.contacts} count={contacts.status === 'ready' && contacts.value.length > 0 ? String(contacts.value.length) : undefined} />
      <TransportLine connectivity={connectivity} />
      <div className="flex min-h-0 flex-1 flex-col gap-5 overflow-auto px-4 pb-4">
        <InterruptedEncounters />
        {contacts.status === 'loading' ? <CenteredNote text={t.shell.loading} /> : null}
        {contacts.status === 'error' ? <CenteredNote text={t.app.errorTitle} /> : null}
        {empty ? (
          <EmptyState
            icon={<PersonIcon />}
            title={t.contacts.emptyTitle}
            body={t.contacts.emptyBody}
            alone={alone}
            action={
              alone ? (
                <Button size="lg" className="[&_svg]:size-[18px]" onClick={verify}>
                  <VerifyIcon />
                  {t.shell.verifyInPerson}
                </Button>
              ) : undefined
            }
          />
        ) : null}
        {contacts.status === 'ready' && contacts.value.length > 0 ? (
          <div ref={listRef} tabIndex={-1} className="flex-none divide-y divide-border overflow-hidden rounded-lg border border-border bg-card outline-none">
            {contacts.value.map((c) => {
              const conv = c.conversation
              return (
                <ConversationRow
                  key={c.id}
                  kind="contact"
                  name={c.name ?? t.contacts.unnamed}
                  image={c.image}
                  verification={c.verification}
                  trust={c.trust}
                  time={conv.lastActivityAt === null ? '' : fmt.time(conv.lastActivityAt)}
                  preview={previewText(conv.preview, i18n, { group: false })}
                  pending={conv.openDecisions > 0}
                  unread={conv.unread}
                  blocked={c.blocked}
                  selected={selected === conv.key}
                  onSelect={() => send({ type: 'open', route: { kind: 'chat', key: conv.key } })}
                  action={
                    c.blocked ? undefined : (
                      <Switch
                        className="hit-target relative"
                        aria-label={f(c.trust.given ? t.contacts.trustOff : t.contacts.trustOn, { name: c.name ?? t.contacts.unnamed })}
                        checked={c.trust.given}
                        onCheckedChange={() => setTrustFor({ id: c.id, name: c.name ?? t.contacts.unnamed, mode: c.trust.given ? 'off' : 'on' })}
                      />
                    )
                  }
                />
              )
            })}
          </div>
        ) : null}
      </div>
      {alone && empty ? null : <FooterAction icon={<VerifyIcon />} label={t.shell.verifyInPerson} onClick={verify} />}
      {trustFor ? <TrustSheet contactId={trustFor.id} name={trustFor.name} mode={trustFor.mode} open onClose={() => setTrustFor(null)} fallbackFocus={listRef} /> : null}
    </>
  )
}
