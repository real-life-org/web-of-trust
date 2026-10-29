// App shell after the prototype: desktop = sidebar + list column (380 px) + detail pane where there is
// content, one column where there is none (an empty list, the groups placeholder, the profile);
// mobile = list or conversation full screen, bottom bar with three tabs. Flows (verify, report, and the
// identity flows the gate hands over) are pages in the content column, with the sidebar; the
// questions (counter-verification, success) are dialogs over whatever is shown (app/layout.ts).
import { useState, type ReactElement, type ReactNode } from 'react'
import { flowAsks, flowCovers, useBackDispatch, useContacts, useDecisions, useGroups, useIdentityActions, useIncoming, useMediaQuery, useMutualMoments, useNav, useSystemBack, type VerifyState } from '../hooks'
import { useI18n } from '../i18n'
import { cn, useToast } from '../ui/primitives'
import { BottomNav, CenteredNote, ContactsIcon, MainLandmark, NetworkIcon, PageFrame, ProfileIcon, SideNav, type NavItem } from '../ui/components'
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
import { useIdentityPage } from './identity-page'
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

/** the three areas of the sidebar and the bottom bar; `before` runs ahead of a change of area */
function useNavItems(before?: () => void): NavItem[] {
  const { t } = useI18n()
  const { state, send } = useNav()
  const badges = useTabBadges()
  const icons: Record<Tab, ReactElement> = { contacts: <ContactsIcon />, groups: <NetworkIcon />, profile: <ProfileIcon /> }
  return (['contacts', 'groups', 'profile'] as const).map((tab) => ({
    id: tab,
    label: t.nav[tab],
    icon: icons[tab],
    active: state.tab === tab,
    badge: badges[tab],
    onSelect: () => {
      before?.()
      send({ type: 'selectTab', tab })
    },
  }))
}

/** The app frame around a page alone, without the shell's areas: the screen catalog shows a flow's
 *  state in it (harness), as the shell would show the page. */
export function AppPageFrame({ children }: { children: ReactNode }) {
  const { t } = useI18n()
  const items = useNavItems()
  return (
    <div className="relative flex min-h-0 flex-1 overflow-hidden bg-background text-foreground">
      <SideNav items={items} appName={t.app.name} />
      <MainLandmark className="contents">
        <section className="flex min-w-0 flex-1 flex-col bg-background">{children}</section>
      </MainLandmark>
    </div>
  )
}

export function Shell() {
  const { t } = useI18n()
  const { state, send } = useNav()
  const toast = useToast()
  const identity = useIdentityActions()
  const { active: identityPage, place: identitySlot, leave: leaveIdentity } = useIdentityPage()
  const contacts = useContacts()
  const wide = useMediaQuery(WIDE_QUERY)
  const panes = shellPanes(state.stack, { tab: state.tab, empty: !(contacts.status === 'ready' && contacts.value.length > 0) })
  // an identity flow handed over by the gate is the page; the navigation stays as it is below it
  const mode = identityPage ? 'page' : panes.mode
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

  const items = useNavItems(identityPage ? leaveIdentity : undefined)
  const route = (r: Route) => <RouteScreen route={r} onVerifyExit={onVerifyExit} onVerifyState={setVerify} onReportExit={onReportExit} onBack={() => send({ type: 'back' })} />

  return (
    <div className="relative flex min-h-0 flex-1 overflow-hidden bg-background text-foreground">
      <SideNav items={items} appName={t.app.name} />
      {/* display: contents keeps the two panes flex children of the shell row */}
      <MainLandmark className="contents">
        <section
          // a page takes the content column on every width: the list stays mounted (its scroll
          // position), hidden
          hidden={mode === 'page'}
          className={cn(
            'min-w-0 flex-col bg-background',
            mode === 'page'
              ? undefined
              : mode === 'single'
                ? // the area alone: one centered column (canvas "Leer", "Profil"), no second column
                  'flex flex-1 md:items-center md:*:w-full md:*:max-w-[720px]'
                : cn('md:flex md:max-w-[380px] md:flex-[0_0_380px] md:border-r md:border-border', panes.listHidden ? 'hidden' : 'flex flex-1'),
          )}
        >
          {state.tab === 'contacts' ? (
            <ContactListScreen alone={wide && mode === 'single'} />
          ) : state.tab === 'profile' ? (
            <IdentitySettingsScreen onChangeProtection={identity.openProtection} onDelete={identity.openDelete} onLock={identity.lock} />
          ) : (
            <PlaceholderScreen title={t.nav[state.tab]} />
          )}
          <BottomNav items={items} />
        </section>
        <section hidden={mode === 'single'} className={cn('min-w-0 flex-1 flex-col bg-background', mode === 'page' ? 'flex' : mode === 'single' ? undefined : panes.listHidden ? 'flex' : 'hidden md:flex')}>
          {identityPage ? (
            <div ref={identitySlot} className="contents" />
          ) : panes.page ? (
            // one position in the tree for the page, phone or desktop: it never remounts on a resize
            <PageFrame variant="app" wide={wide} area={t.nav[state.tab]} onEscape={() => void escape()}>
              {route(panes.page)}
            </PageFrame>
          ) : panes.detail ? (
            route(panes.detail)
          ) : mode === 'columns' ? (
            <CenteredNote text={t.shell.pickOne} />
          ) : null}
        </section>
      </MainLandmark>
      {/* the questions: dialogs over whatever is shown (also over the verify page); not over an
          identity flow, which asks nothing else in between */}
      {identityPage ? null : moments.current ? (
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
