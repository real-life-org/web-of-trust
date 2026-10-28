// App shell after the prototype: desktop = sidebar + list column (380 px) + detail pane;
// mobile = list or conversation full screen, bottom bar with three tabs.
import type { ReactElement } from 'react'
import { useContacts, useDecisions, useGroups, useIdentityActions, useNav, useSystemBack, type VerifyState } from '../hooks'
import { useI18n } from '../i18n'
import { cn, useToast } from '../ui/primitives'
import { BottomNav, CenteredNote, ContactsIcon, MainLandmark, NetworkIcon, ProfileIcon, SideNav, type NavItem } from '../ui/components'
import { ContactListScreen } from '../screens/contacts/ContactListScreen'
import { ConversationScreen } from '../screens/chat/ConversationScreen'
import { ContactDetailScreen } from '../screens/contacts/ContactDetailScreen'
import { VerifyScreen } from '../screens/verify/VerifyScreen'
import { ReportScreen } from '../screens/report/ReportScreen'
import { InteropProbeScreen } from '../screens/developer/InteropProbeScreen'
import { PlaceholderScreen } from '../screens/system/PlaceholderScreen'
import { IdentitySettingsScreen } from '../screens/identity/IdentitySettingsScreen'
import type { Route, Tab } from './nav'
import type { ContactId } from '../port'

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
  const toast = useToast()
  const badges = useTabBadges()
  const identity = useIdentityActions()
  const top = state.stack[state.stack.length - 1] ?? null
  // system back without a flow: sheet, stack, tab "contacts", then the app is left (§4.1)
  useSystemBack(() => !send({ type: 'back' }), 'nav')
  const onVerifyExit = (s: Extract<VerifyState, { name: 'exit' }>) => {
    if (s.recognized) toast.show(t.verify.recognized)
    if (s.to === 'chat' && s.contactId) send({ type: 'open', route: { kind: 'chat', key: `c:${s.contactId}` } })
    else send({ type: 'back' })
  }
  const onReportExit = (to: 'back' | 'chat', contactId: ContactId) => {
    if (to === 'chat') send({ type: 'open', route: { kind: 'chat', key: `c:${contactId}` } })
    else send({ type: 'back' })
  }

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
      {/* display: contents keeps the two panes flex children of the shell row */}
      <MainLandmark className="contents">
        <section
          className={cn(
            'min-w-0 flex-col bg-background md:flex md:max-w-[380px] md:flex-[0_0_380px] md:border-r md:border-border',
            top ? 'hidden' : 'flex flex-1',
          )}
        >
          {state.tab === 'contacts' ? (
            <ContactListScreen />
          ) : state.tab === 'profile' ? (
            <IdentitySettingsScreen onChangeProtection={identity.openProtection} onDelete={identity.openDelete} onLock={identity.lock} />
          ) : (
            <PlaceholderScreen title={t.nav[state.tab]} />
          )}
          <BottomNav items={items} />
        </section>
        <section className={cn('min-w-0 flex-1 flex-col bg-background', top ? 'flex' : 'hidden md:flex')}>
          {top ? <RouteScreen route={top} onVerifyExit={onVerifyExit} onReportExit={onReportExit} onBack={() => send({ type: 'back' })} /> : <CenteredNote text={t.shell.pickOne} />}
        </section>
      </MainLandmark>
    </div>
  )
}

function RouteScreen({
  route,
  onVerifyExit,
  onReportExit,
  onBack,
}: {
  route: Route
  onVerifyExit: (s: Extract<VerifyState, { name: 'exit' }>) => void
  onReportExit: (to: 'back' | 'chat', contactId: ContactId) => void
  onBack: () => void
}) {
  switch (route.kind) {
    case 'chat':
      return <ConversationScreen key={route.key} conversationKey={route.key} />
    case 'contact':
      return <ContactDetailScreen key={route.id} contactId={route.id} />
    case 'verify':
      return <VerifyScreen onExit={onVerifyExit} />
    case 'report':
      return <ReportScreen key={route.id} contactId={route.id} onExit={(to) => onReportExit(to, route.id)} />
    case 'interop':
      return <InteropProbeScreen onBack={onBack} />
  }
}
