// App shell after the prototype: desktop = sidebar + list column (380 px) + detail pane;
// mobile = list or conversation full screen, bottom bar with three tabs.
import type { ReactElement } from 'react'
import { useContacts, useDecisions, useGroups, useNav } from '../hooks'
import { useI18n } from '../i18n'
import { cn } from '../ui/primitives'
import { BottomNav, CenteredNote, ContactsIcon, NetworkIcon, ProfileIcon, SideNav, type NavItem } from '../ui/components'
import { ContactListScreen } from '../screens/contacts/ContactListScreen'
import { ConversationScreen } from '../screens/chat/ConversationScreen'
import { PlaceholderScreen } from '../screens/system/PlaceholderScreen'
import type { Tab } from './nav'

function useTabBadges(): Record<Tab, number> {
  const contacts = useContacts()
  const groups = useGroups()
  const decisions = useDecisions()
  const unreadContacts = contacts.status === 'ready' ? contacts.value.filter((c) => c.conversation.unread > 0).length : 0
  const unreadGroups = groups.status === 'ready' ? groups.value.filter((g) => g.conversation.unread > 0).length : 0
  const invites = decisions.status === 'ready' ? decisions.value.filter((d) => d.kind === 'group-invite').length : 0
  return { contacts: unreadContacts, groups: unreadGroups + invites, profile: 0 }
}

export function Shell() {
  const { t } = useI18n()
  const { state, send } = useNav()
  const badges = useTabBadges()
  const top = state.stack[state.stack.length - 1] ?? null

  const icons: Record<Tab, ReactElement> = { contacts: <ContactsIcon />, groups: <NetworkIcon />, profile: <ProfileIcon /> }
  const items: NavItem[] = (['contacts', 'groups', 'profile'] as const).map((tab) => ({
    id: tab,
    label: t.nav[tab],
    icon: icons[tab],
    active: state.tab === tab,
    badge: badges[tab],
    onSelect: () => send({ type: 'selectTab', tab }),
  }))

  return (
    <div className="relative flex min-h-0 flex-1 overflow-hidden bg-background text-foreground">
      <SideNav items={items} appName={t.app.name} />
      <section
        className={cn(
          'min-w-0 flex-col bg-background md:flex md:max-w-[380px] md:flex-[0_0_380px] md:border-r md:border-border',
          top ? 'hidden' : 'flex flex-1',
        )}
      >
        {state.tab === 'contacts' ? <ContactListScreen /> : <PlaceholderScreen title={t.nav[state.tab]} />}
        <BottomNav items={items} />
      </section>
      <section className={cn('min-w-0 flex-1 flex-col bg-background', top ? 'flex' : 'hidden md:flex')}>
        {top ? <ConversationScreen key={top.key} conversationKey={top.key} /> : <CenteredNote text={t.shell.pickOne} />}
      </section>
    </div>
  )
}
