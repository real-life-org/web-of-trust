// The screens around a person met again (Trust 6a.4): the success says "Met again · recognized" only for a
// real second meeting (a contact joined into one known before), not for the same card read again; the
// success's actions follow the contact's availability (no trust for a blocked person); the invitation
// dialog knows a contact invited under the id it had before the chaining; the conversation of an alias
// finds its unread count.
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { ReactNode } from 'react'
import { createNavStore } from '../src/app/nav'
import { AppContextProvider } from '../src/hooks'
import { LanguageProvider } from '../src/i18n'
import { ToastProvider } from '../src/ui/primitives'
import { composeScenario } from '../harness/boot'
import { iiw } from '../harness/scenarios'
import { VerifyView } from '../src/screens/verify/VerifyScreen'
import { MutualSheet } from '../src/screens/verify/MutualSheet'
import { GroupInviteScreen } from '../src/screens/groups/GroupInviteScreen'
import { summaryOfKey } from '../src/screens/chat/first-unread'
import type { VerifyState } from '../src/flows/verify'
import { ready, writableStore } from '../src/port'
import type { AppPort, ContactDetail, ContactId, ContactListItem, GroupDetail, GroupId, Loadable, Result, Revision } from '../src/port'

const REV = '1:1:1' as Revision
const done = <T,>(r: Result<T>) => ({ actId: 'x' as never, done: Promise.resolve(r) })

function mount(ui: (port: AppPort) => ReactNode, over: (port: AppPort) => Partial<AppPort['stores']> = () => ({})) {
  const comp = composeScenario(iiw)
  const port: AppPort = { ...comp.port, stores: { ...comp.port.stores, ...over(comp.port) } }
  render(
    <LanguageProvider lang="en">
      <AppContextProvider value={{ port, platform: comp.platform, nav: createNavStore() }}>
        <ToastProvider>{ui(port)}</ToastProvider>
      </AppContextProvider>
    </LanguageProvider>,
  )
  return port
}

const success = (over: Partial<Extract<VerifyState, { name: 'success' }>> = {}) =>
  ({ name: 'success', run: 1, mutual: [], contactId: 'marcus' as ContactId, name2: 'Marcus Chen', isNew: false, recognized: false, ...over }) as VerifyState

/** Marcus's details as the port gives them, blocked: no trust toward him (the projection's availability) */
const blockedDetail = (port: AppPort): ReturnType<AppPort['stores']['contact']> => {
  const d = port.stores.contact('marcus' as ContactId).get() as Loadable<ContactDetail | null>
  if (d.status !== 'ready' || !d.value) throw new Error('scenario: Marcus')
  return writableStore(ready({ ...d.value, blocked: true, actions: { ...d.value.actions, giveTrust: { ok: false, reason: 'blocked' } } }, REV))
}

describe('the success of a second meeting', () => {
  it('the same card read again (not new, nothing joined): the plain success, no "Met again"', async () => {
    mount(() => <VerifyView state={success({ isNew: false, recognized: false })} send={() => undefined} />)
    expect(await screen.findByText('You and Marcus are now connected.')).toBeInTheDocument()
    expect(screen.queryByText('Met again · recognized')).toBeNull()
  })

  it('a contact joined into one known before: its name and "Met again · recognized"', async () => {
    mount(() => <VerifyView state={success({ isNew: false, recognized: true })} send={() => undefined} />)
    expect(await screen.findByText('Met again · recognized')).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Marcus Chen' })).toBeInTheDocument()
  })
})

describe('the success’s actions follow the contact’s availability', () => {
  it('a blocked contact on the success screen: no trust offered, the chat', async () => {
    mount(() => <VerifyView state={success()} send={() => undefined} />, (port) => ({ contact: () => blockedDetail(port) }))
    expect(await screen.findByRole('button', { name: 'Open chat' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Trust Marcus' })).toBeNull()
  })

  it('a blocked contact in the success sheet: no trust offered, the chat', async () => {
    mount(() => <MutualSheet contactId={'marcus' as ContactId} name="Marcus Chen" onOpenChat={() => undefined} onClose={() => undefined} />, (port) => ({ contact: () => blockedDetail(port) }))
    expect(await screen.findByRole('button', { name: 'Open chat' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Trust Marcus' })).toBeNull()
  })
})

describe('an id from before the chaining', () => {
  it('the invitation dialog: a contact invited under its fresh id stays invited once that id is an alias of the known one', async () => {
    const comp = composeScenario(iiw)
    const list0 = comp.port.stores.contacts.get() as Loadable<readonly ContactListItem[]>
    if (list0.status !== 'ready') throw new Error('scenario')
    const marcus = list0.value.find((c) => c.id === 'marcus')!
    // before the chaining the list holds the second meeting's fresh contact; after it the known one with the alias
    const contacts = writableStore<Loadable<readonly ContactListItem[]>>(ready(list0.value.map((c) => (c.id === 'marcus' ? { ...c, id: 'marcus-2' as ContactId, channel: true } : c)), REV))
    const group: GroupDetail = {
      id: 'g1' as GroupId, name: 'Garten', membership: 'member', role: 'founder', knownMembers: 1, myHandle: 'h', openAdmissions: 0, awaiting: null,
      conversation: { key: 'g:g1', preview: null, unread: 0, openDecisions: 0, lastActivityAt: null, muted: false },
      visibleMembers: [], anonymousMembers: 0, admissions: [], invitesOut: [], listed: true, vouchThreshold: 1,
      actions: { invite: { ok: true }, leave: { ok: true }, report: { ok: false, reason: 'not-supported' } },
    }
    const invite = vi.fn(() => done<void>({ ok: true, value: undefined }))
    const port: AppPort = { ...comp.port, stores: { ...comp.port.stores, contacts, group: () => writableStore(ready(group, REV)) }, trust: { ...comp.port.trust, invite } }
    render(
      <LanguageProvider lang="en">
        <AppContextProvider value={{ port, platform: comp.platform, nav: createNavStore() }}>
          <GroupInviteScreen groupId={'g1' as GroupId} onBack={() => undefined} />
        </AppContextProvider>
      </LanguageProvider>,
    )
    fireEvent.click(await screen.findByRole('button', { name: 'Invite Marcus Chen' }))
    await waitFor(() => expect(invite).toHaveBeenCalledWith('g1', 'marcus-2'))
    expect(await screen.findByText('Invited')).toBeInTheDocument()
    // the chaining: the known contact, the fresh id its alias
    contacts.set(ready(list0.value.map((c) => (c.id === 'marcus' ? { ...marcus, channel: true, aliases: ['marcus-2' as ContactId] } : c)), REV))
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Invite Marcus Chen' })).toBeNull())
    expect(screen.getByText('Invited')).toBeInTheDocument()
  })

  it('the conversation of an alias finds the known contact’s summary (its unread count)', () => {
    const list = [{ id: 'bea', aliases: ['bea-2'], conversation: { key: 'c:bea', preview: null, unread: 2, openDecisions: 0, lastActivityAt: null, muted: false } }] as unknown as ContactListItem[]
    expect(summaryOfKey(list, 'c:bea-2')?.unread).toBe(2)
    expect(summaryOfKey(list, 'c:bea')?.unread).toBe(2)
    expect(summaryOfKey(list, 'c:other')).toBeUndefined()
  })
})
