// App shell after the prototype: desktop = sidebar + list column (380 px) + detail pane;
// mobile = list or conversation full screen, bottom bar with three tabs. Flows (verify, report) are
// not details: on the desktop they are a sheet over the shell, which is inert behind it (app/layout.ts).
import { useState, type ReactElement } from 'react'
import { flowAsks, flowCovers, useBackDispatch, useContacts, useDecisions, useGroups, useIdentityActions, useIncoming, useMediaQuery, useMutualMoments, useNav, useSystemBack, type VerifyState } from '../hooks'
import { useI18n } from '../i18n'
import { cn, useToast } from '../ui/primitives'
import { BottomNav, CenteredNote, ContactsIcon, FlowSheet, MainLandmark, NetworkIcon, ProfileIcon, SideNav, type NavItem } from '../ui/components'
import { ContactListScreen } from '../screens/contacts/ContactListScreen'
import { ConversationScreen } from '../screens/chat/ConversationScreen'
import { ContactDetailScreen } from '../screens/contacts/ContactDetailScreen'
import { VerifyScreen } from '../screens/verify/VerifyScreen'
import { MutualSheet } from '../screens/verify/MutualSheet'
import { CounterSheet } from '../screens/contacts/CounterSheet'
import { ReportScreen } from '../screens/report/ReportScreen'
import { InteropProbeScreen } from '../screens/developer/InteropProbeScreen'
import { PlaceholderScreen } from '../screens/system/PlaceholderScreen'
import { IdentitySettingsScreen } from '../screens/identity/IdentitySettingsScreen'
import type { Route, Tab } from './nav'
import { shellPanes, WIDE_QUERY } from './layout'
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
  const panes = shellPanes(state.stack, useMediaQuery(WIDE_QUERY))
  const sheet = panes.flow?.as === 'sheet'
  const escape = useBackDispatch()
  // system back without a flow: sheet, stack, tab "contacts", then the app is left (§4.1)
  useSystemBack(() => !send({ type: 'back' }), 'nav')
  // the verify flow's state: what it asks for itself is not asked again (2.4, 2.7)
  const [verify, setVerify] = useState<VerifyState | null>(null)
  const moments = useMutualMoments((id) => flowCovers(verify, id))
  // the success sheet first, then the next incoming confirmation (2.7 step 4)
  const queue = useIncoming(verify, flowAsks(verify) || moments.current !== null)
  const onVerifyExit = (s: Extract<VerifyState, { name: 'exit' }>) => {
    if (s.deferred) queue.send({ type: 'defer', id: s.deferred })
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
      {/* behind an open flow sheet the shell is inert: no focus, no pointer, hidden from assistive technology */}
      <div inert={sheet} className="contents">
        <SideNav items={items} appName={t.app.name} />
        {/* display: contents keeps the two panes flex children of the shell row */}
        <MainLandmark className="contents">
          <section
            className={cn(
              'min-w-0 flex-col bg-background md:flex md:max-w-[380px] md:flex-[0_0_380px] md:border-r md:border-border',
              panes.listHidden ? 'hidden' : 'flex flex-1',
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
          <section className={cn('min-w-0 flex-1 flex-col bg-background', panes.listHidden ? 'flex' : 'hidden md:flex')}>
            {panes.flow?.as === 'screen' ? null : panes.detail ? (
              <RouteScreen route={panes.detail} onVerifyExit={onVerifyExit} onVerifyState={setVerify} onReportExit={onReportExit} onBack={() => send({ type: 'back' })} />
            ) : (
              <CenteredNote text={t.shell.pickOne} />
            )}
            {/* one position in the tree for the flow, screen or sheet: it never remounts on a resize */}
            {panes.flow ? (
              <FlowSheet as={panes.flow.as} label={t.app.name} onEscape={() => void escape()}>
                <RouteScreen route={panes.flow.route} onVerifyExit={onVerifyExit} onVerifyState={setVerify} onReportExit={onReportExit} onBack={() => send({ type: 'back' })} />
              </FlowSheet>
            ) : null}
          </section>
        </MainLandmark>
      </div>
      {/* the success and the incoming confirmations stay outside the inert wrapper: they open over an
          open flow sheet too, and must stay usable */}
      {moments.current ? (
        <MutualSheet
          key={moments.current.contactId}
          name={moments.current.name ?? t.contacts.unnamed}
          onClose={moments.dismiss}
          onOpenChat={() => {
            const id = moments.current?.contactId
            moments.dismiss()
            if (id) send({ type: 'open', route: { kind: 'chat', key: `c:${id}` } })
          }}
        />
      ) : queue.state.name === 'asking' ? (
        <CounterSheet
          key={queue.state.head.id}
          contactId={queue.state.head.contactId}
          name={queue.state.head.name ?? t.contacts.unnamed}
          open
          when="now"
          position={queue.position}
          onClose={() => queue.send({ type: 'notNow' })}
          run={{ busy: queue.state.busy, failed: queue.state.failed, confirm: () => queue.send({ type: 'confirm' }) }}
        />
      ) : null}
    </div>
  )
}

function RouteScreen({
  route,
  onVerifyExit,
  onVerifyState,
  onReportExit,
  onBack,
}: {
  route: Route
  onVerifyExit: (s: Extract<VerifyState, { name: 'exit' }>) => void
  onVerifyState: (s: VerifyState | null) => void
  onReportExit: (to: 'back' | 'chat', contactId: ContactId) => void
  onBack: () => void
}) {
  switch (route.kind) {
    case 'chat':
      return <ConversationScreen key={route.key} conversationKey={route.key} />
    case 'contact':
      return <ContactDetailScreen key={route.id} contactId={route.id} />
    case 'verify':
      return <VerifyScreen onExit={onVerifyExit} onState={onVerifyState} />
    case 'report':
      return <ReportScreen key={route.id} contactId={route.id} onExit={(to) => onReportExit(to, route.id)} />
    case 'interop':
      return <InteropProbeScreen onBack={onBack} />
  }
}
