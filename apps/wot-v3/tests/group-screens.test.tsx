// The groups area (prototype "Groups", Anton 22.11.): the menu entry with its list, a group's details
// with who invited whom, founding a group, inviting a contact, leaving.
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { createNavStore, navTransition, INITIAL_NAV, type NavStore } from '../src/app/nav'
import { isPageRoute, shellPanes } from '../src/app/layout'
import { AppContextProvider } from '../src/hooks'
import { LanguageProvider } from '../src/i18n'
import { en } from '../src/i18n/en'
import { composeScenario } from '../harness/boot'
import { iiw } from '../harness/scenarios'
import { GroupListScreen, groupLine } from '../src/screens/groups/GroupListScreen'
import { GroupDetailView, provenanceLine } from '../src/screens/groups/GroupDetailScreen'
import { GroupFoundScreen } from '../src/screens/groups/GroupFoundScreen'
import { GroupInviteScreen } from '../src/screens/groups/GroupInviteScreen'
import { writableStore, ready } from '../src/port'
import type { AppPort, ContactId, GroupDetail, GroupId, GroupMember, MemberRef, Result, Revision } from '../src/port'
import type { ReactNode } from 'react'

const done = <T,>(r: Result<T>) => ({ actId: 'x' as never, done: Promise.resolve(r) })
const FAILED = { ok: false, error: { kind: 'infra', code: 'transport', retryable: true } } as const
const f = (s: string, v: Record<string, string | number>) => s.replace(/\{(\w+)\}/g, (_, k: string) => String(v[k] ?? ''))

const member = ({ member: m, ...over }: Omit<Partial<GroupMember>, 'member'> & { member: string }): GroupMember => ({ handle: m.slice(-6), self: false, contactId: null, name: null, invitedBy: null, ...over, member: m as MemberRef })
const AL = member({ member: 'did:key:al-000001', name: 'Al', self: true, invitedBy: [] })
const inviterAl = { member: AL.member, handle: AL.handle, self: true, contactId: null, name: 'Al' }
const BEA = member({ member: 'did:key:bea-00002', name: 'Bea', contactId: 'priya' as ContactId, invitedBy: [inviterAl] })
const inviterBea = { member: BEA.member, handle: BEA.handle, self: false, contactId: 'priya' as ContactId, name: 'Bea' }
const CY = member({ member: 'did:key:cy-000003', invitedBy: [inviterBea, { member: 'did:key:gone-0004' as MemberRef, handle: 'e-0004', self: false, contactId: null, name: null }] })

const group = (over: Partial<GroupDetail> = {}): GroupDetail => ({
  id: 'g1' as GroupId, name: 'Garten', membership: 'member', role: 'founder', knownMembers: 3, myHandle: AL.handle, openAdmissions: 0, awaiting: null,
  conversation: { key: 'g:g1', preview: null, unread: 0, openDecisions: 0, lastActivityAt: null, muted: false },
  visibleMembers: [AL, BEA, CY], anonymousMembers: 0, admissions: [], invitesOut: [], listed: true, vouchThreshold: 1,
  actions: { invite: { ok: true }, leave: { ok: true }, report: { ok: false, reason: 'not-supported' } },
  ...over,
})

function mountBoth(ui: ReactNode, over: { trust?: Partial<AppPort['trust']>; group?: GroupDetail | null } = {}, nav: NavStore = createNavStore()) {
  const comp = composeScenario(iiw)
  const detail = writableStore(ready(over.group === undefined ? group() : over.group, '1:1:1' as Revision))
  const port: AppPort = { ...comp.port, stores: { ...comp.port.stores, group: () => detail }, trust: { ...comp.port.trust, ...over.trust } }
  const view = render(
    <LanguageProvider lang="en">
      <AppContextProvider value={{ port, platform: comp.platform, nav }}>{ui}</AppContextProvider>
    </LanguageProvider>,
  )
  return { nav, view }
}

const mount = (...a: Parameters<typeof mountBoth>) => mountBoth(...a).nav
const mountView = (...a: Parameters<typeof mountBoth>) => mountBoth(...a).view

describe('a group one accepted into, before the inviter answered', () => {
  it('says whom the join waits for, by first name; without a known inviter it waits for an answer', () => {
    const waiting = group({ membership: 'joining', knownMembers: 0, visibleMembers: [], awaiting: { contactId: 'priya' as ContactId, name: 'Priya Raman' } })
    expect(groupLine(waiting, en.groups, f)).toBe('Accepted · waiting for Priya')
    expect(groupLine({ ...waiting, awaiting: { contactId: null, name: null } }, en.groups, f)).toBe('Accepted · waiting for an answer')
    // welcomed, the log has not confirmed yet: the inviter answered, nothing is awaited
    expect(groupLine({ ...waiting, awaiting: null }, en.groups, f)).toBe(en.groups.joining)
  })
})

describe('navigation and frames', () => {
  it('a group\'s routes belong to the groups, every other route to the contacts', () => {
    const open = (route: Parameters<typeof navTransition>[1] & { type: 'open' }) => navTransition(INITIAL_NAV, route).state
    expect(open({ type: 'open', route: { kind: 'group', id: 'g1' as GroupId } }).tab).toBe('groups')
    expect(open({ type: 'open', route: { kind: 'group-found' } }).tab).toBe('groups')
    expect(open({ type: 'open', route: { kind: 'chat', key: 'c:x' } }).tab).toBe('contacts')
    // back from the groups area leads to the contacts, then out of the app
    const inGroups = navTransition(INITIAL_NAV, { type: 'selectTab', tab: 'groups' }).state
    expect(navTransition(inGroups, { type: 'back' })).toMatchObject({ state: { tab: 'contacts' }, exit: false })
  })

  it('founding and inviting are pages; the groups area has two columns once there is something to pick', () => {
    expect([isPageRoute({ kind: 'group-found' }), isPageRoute({ kind: 'group-invite', id: 'g1' as GroupId }), isPageRoute({ kind: 'group', id: 'g1' as GroupId })]).toEqual([true, true, false])
    expect(shellPanes([], { tab: 'groups', empty: false }).mode).toBe('columns')
    expect(shellPanes([], { tab: 'groups', empty: true }).mode).toBe('single')
    expect(shellPanes([{ kind: 'group-found' }], { tab: 'groups', empty: true })).toMatchObject({ mode: 'page', page: { kind: 'group-found' } })
  })
})

describe('the groups list', () => {
  it('the open invitation first, answered in the conversation with the inviter; then the groups', async () => {
    const nav = mount(<GroupListScreen />)
    expect(await screen.findByRole('heading', { name: 'Groups' })).toBeInTheDocument()
    const invitation = screen.getByRole('button', { name: /Key Recovery WG/ })
    expect(within(invitation).getByText('Priya Raman invites you')).toBeInTheDocument()
    expect(within(invitation).getByText('Respond')).toBeInTheDocument()
    fireEvent.click(invitation)
    expect(nav.get()).toMatchObject({ tab: 'contacts', stack: [{ kind: 'chat', key: 'c:priya' }] })
    expect(screen.getByRole('button', { name: /Offline-First Circle/ })).toBeInTheDocument()
    expect(screen.getByText('14 members')).toBeInTheDocument()
  })

  it('a group opens its details; "Found a group" opens the page', async () => {
    const nav = mount(<GroupListScreen />)
    fireEvent.click(await screen.findByRole('button', { name: /Hofgemeinschaft Lindenhof/ }))
    expect(nav.get()).toMatchObject({ tab: 'groups', stack: [{ kind: 'group', id: 'hof' }] })
    fireEvent.click(screen.getByRole('button', { name: 'Found a group' }))
    expect(nav.get().stack.at(-1)).toEqual({ kind: 'group-found' })
  })
})

describe('through whom a member came in', () => {
  const x = en.groups
  it('the founder, one inviter, two inviters, the own invitation, and nothing where the group does not tell', () => {
    expect(provenanceLine(AL, x, f)).toBe('You founded the group')
    expect(provenanceLine({ ...AL, self: false }, x, f)).toBe('Founded the group')
    expect(provenanceLine(BEA, x, f)).toBe('Invited by you')
    expect(provenanceLine(CY, x, f)).toBe('Invited by Bea and Member e-0004')
    expect(provenanceLine({ ...BEA, self: true, invitedBy: [inviterBea] }, x, f)).toBe('Invited by Bea')
    expect(provenanceLine({ ...BEA, invitedBy: null }, x, f)).toBeNull()
  })
})

describe('a group\'s details', () => {
  it('says under which name the person appears and how they came in, and lists the others with who invited them', () => {
    mount(<GroupDetailView group={group()} onBack={() => undefined} />)
    expect(screen.getByText('You appear as Al')).toBeInTheDocument()
    expect(screen.getByText('You founded the group')).toBeInTheDocument()
    expect(screen.getByText('3 members')).toBeInTheDocument()
    expect(screen.getByText('Invited by you')).toBeInTheDocument()
    // a member without a name shows the short form of its key
    expect(screen.getByText(`Member ${CY.handle}`)).toBeInTheDocument()
    expect(screen.getByText('Invited by Bea and Member e-0004')).toBeInTheDocument()
  })

  it('a member that is a contact opens that contact; another member opens nothing', () => {
    const nav = mount(<GroupDetailView group={group()} onBack={() => undefined} />)
    fireEvent.click(screen.getByRole('button', { name: /Bea/ }))
    expect(nav.get().stack.at(-1)).toEqual({ kind: 'contact', id: 'priya' })
    expect(screen.queryByRole('button', { name: new RegExp(`Member ${CY.handle}`) })).toBeNull()
  })

  it('leaving asks first, says that it cannot be undone, and leaves through the port', async () => {
    const leaveGroup = vi.fn(() => done<void>({ ok: true, value: undefined }))
    mount(<GroupDetailView group={group()} onBack={() => undefined} />, { trust: { leaveGroup } })
    fireEvent.click(screen.getByRole('button', { name: 'Leave the group' }))
    const sheet = await screen.findByRole('dialog')
    expect(within(sheet).getByText('The other members are told. You cannot join this group again afterwards.')).toBeInTheDocument()
    expect(leaveGroup).not.toHaveBeenCalled()
    fireEvent.click(within(sheet).getByRole('button', { name: 'Leave' }))
    await waitFor(() => expect(leaveGroup).toHaveBeenCalledWith('g1'))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  })

  it('a failed leave says so and keeps the question open', async () => {
    mount(<GroupDetailView group={group()} onBack={() => undefined} />, { trust: { leaveGroup: vi.fn(() => done<void>(FAILED)) } })
    fireEvent.click(screen.getByRole('button', { name: 'Leave the group' }))
    fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Leave' }))
    expect(await screen.findByText('That did not go through. Please try again.')).toBeInTheDocument()
    expect(screen.getByRole('dialog')).toBeInTheDocument()
  })

  it('a group the person left offers neither inviting nor leaving, and says so under its name', () => {
    const left = group({ membership: 'left', actions: { invite: { ok: false, reason: 'not-supported' }, leave: { ok: false, reason: 'not-supported' }, report: { ok: false, reason: 'not-supported' } } })
    mount(<GroupDetailView group={left} onBack={() => undefined} />)
    expect(screen.getByText('You left this group')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Invite a contact' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Leave the group' })).toBeNull()
    expect(screen.queryByText(/You appear as/)).toBeNull()
  })
})

describe('founding a group', () => {
  it('needs a name; founds through the port and hands the new group over', async () => {
    const foundGroup = vi.fn(() => done({ ok: true, value: { groupId: 'g9' as GroupId } }))
    const onFounded = vi.fn()
    mount(<GroupFoundScreen onBack={() => undefined} onFounded={onFounded} />, { trust: { foundGroup } })
    const go = screen.getByRole('button', { name: 'Found the group' })
    expect(go).toBeDisabled()
    fireEvent.change(screen.getByLabelText('Name of the group'), { target: { value: '  Garten  ' } })
    fireEvent.click(go)
    await waitFor(() => expect(foundGroup).toHaveBeenCalledWith({ name: 'Garten' }))
    await waitFor(() => expect(onFounded).toHaveBeenCalledWith('g9'))
  })

  it('a founding that ends after the page was left moves nobody (#537)', async () => {
    let finish: (r: Result<{ groupId: GroupId }>) => void = () => undefined
    const foundGroup = vi.fn(() => ({ actId: 'x' as never, done: new Promise<Result<{ groupId: GroupId }>>((r) => (finish = r)) }))
    const onFounded = vi.fn()
    const view = mountView(<GroupFoundScreen onBack={() => undefined} onFounded={onFounded} />, { trust: { foundGroup } })
    fireEvent.change(screen.getByLabelText('Name of the group'), { target: { value: 'Garten' } })
    fireEvent.click(screen.getByRole('button', { name: 'Found the group' }))
    await waitFor(() => expect(foundGroup).toHaveBeenCalled())
    // the person goes to another area while the founding runs: the page is gone
    view.unmount()
    finish({ ok: true, value: { groupId: 'g9' as GroupId } })
    await new Promise((r) => setTimeout(r, 0))
    expect(onFounded).not.toHaveBeenCalled()
  })

  it('a failure says so and stays on the page', async () => {
    const onFounded = vi.fn()
    mount(<GroupFoundScreen onBack={() => undefined} onFounded={onFounded} />, { trust: { foundGroup: vi.fn(() => done<{ groupId: GroupId }>(FAILED)) } })
    fireEvent.change(screen.getByLabelText('Name of the group'), { target: { value: 'Garten' } })
    fireEvent.click(screen.getByRole('button', { name: 'Found the group' }))
    expect(await screen.findByText('That did not go through. Please try again.')).toBeInTheDocument()
    expect(onFounded).not.toHaveBeenCalled()
  })
})

describe('inviting a contact', () => {
  it('lists the contacts that are not in the group; an invitation goes through the port and the row says invited', async () => {
    const invite = vi.fn(() => done<void>({ ok: true, value: undefined }))
    mount(<GroupInviteScreen groupId={'g1' as GroupId} onBack={() => undefined} />, { trust: { invite } })
    expect(await screen.findByRole('heading', { name: 'Invite into Garten' })).toBeInTheDocument()
    // Priya is in the group already (the member Bea is that contact)
    expect(screen.queryByRole('button', { name: 'Invite Priya Raman' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Invite Marcus Chen' }))
    await waitFor(() => expect(invite).toHaveBeenCalledWith('g1', 'marcus'))
    expect(await screen.findByText('Invited')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Invite Marcus Chen' })).toBeNull()
  })

  it('a failed invitation says so and the contact can be invited again', async () => {
    mount(<GroupInviteScreen groupId={'g1' as GroupId} onBack={() => undefined} />, { trust: { invite: vi.fn(() => done<void>(FAILED)) } })
    fireEvent.click(await screen.findByRole('button', { name: 'Invite Marcus Chen' }))
    expect(await screen.findByText('That did not go through. Please try again.')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Invite Marcus Chen' })).toBeEnabled()
  })
})
