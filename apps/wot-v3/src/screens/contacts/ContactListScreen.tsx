// Contacts tab: messenger list of contacts with their conversation (design: tab "contacts").
import { useContacts, useFormat, useNav } from '../../hooks'
import { useI18n } from '../../i18n'
import {
  CenteredNote,
  ConversationRow,
  EmptyState,
  FooterAction,
  ListHeader,
  PersonIcon,
  VerifyIcon,
  previewText,
} from '../../ui/components'
import { InterruptedEncounters } from './InterruptedEncounters'

export function ContactListScreen() {
  const i18n = useI18n()
  const { t } = i18n
  const contacts = useContacts()
  const { state, send } = useNav()
  const fmt = useFormat()
  const first = state.stack[0]
  const selected = first?.kind === 'chat' ? first.key : null

  return (
    <>
      <ListHeader title={t.nav.contacts} count={contacts.status === 'ready' && contacts.value.length > 0 ? String(contacts.value.length) : undefined} />
      <div className="flex min-h-0 flex-1 flex-col gap-5 overflow-auto px-4 pb-4">
        <InterruptedEncounters />
        {contacts.status === 'loading' ? <CenteredNote text={t.shell.loading} /> : null}
        {contacts.status === 'error' ? <CenteredNote text={t.app.errorTitle} /> : null}
        {contacts.status === 'ready' && contacts.value.length === 0 ? (
          <EmptyState icon={<PersonIcon />} title={t.contacts.emptyTitle} body={t.contacts.emptyBody} />
        ) : null}
        {contacts.status === 'ready' && contacts.value.length > 0 ? (
          <div className="flex-none divide-y divide-border overflow-hidden rounded-lg border border-border bg-card">
            {contacts.value.map((c) => {
              const conv = c.conversation
              return (
                <ConversationRow
                  key={c.id}
                  kind="contact"
                  name={c.name ?? t.contacts.unnamed}
                  verification={c.verification}
                  trust={c.trust}
                  time={conv.lastActivityAt === null ? '' : fmt.time(conv.lastActivityAt)}
                  preview={previewText(conv.preview, i18n, { group: false })}
                  pending={conv.openDecisions > 0}
                  unread={conv.unread}
                  blocked={c.blocked}
                  selected={selected === conv.key}
                  onSelect={() => send({ type: 'open', route: { kind: 'chat', key: conv.key } })}
                />
              )
            })}
          </div>
        ) : null}
      </div>
      <FooterAction icon={<VerifyIcon />} label={t.shell.verifyInPerson} onClick={() => send({ type: 'open', route: { kind: 'verify' } })} />
    </>
  )
}
