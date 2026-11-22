// Groups tab (prototype "Groups", Anton 22.11.): the open invitations first, then the groups this
// person is in. A group has no conversation yet, so a row opens the group's details; the conversation
// will slide in front of them later (design brief, "the only navigation rule"). Alone (the desktop
// without a second column): an empty list is a centered empty state that carries "Found a group" itself.
import { useContacts, useDecisions, useGroups, useNav } from '../../hooks'
import { useI18n } from '../../i18n'
import { Button } from '../../ui/primitives'
import { CenteredNote, ChevronRightIcon, ConversationRow, EmptyState, FooterAction, GroupsIcon, ListHeader, PersonAvatar, PlusIcon } from '../../ui/components'
import type { Decision, GroupListItem } from '../../port'
import type { Translations } from '../../i18n/types'

type Invite = Extract<Decision, { kind: 'group-invite' }>

/** what a group's row says under its name: the own standing where it is not plain membership, else how many are in it */
export function groupLine(g: GroupListItem, x: Translations['groups'], f: (s: string, v: Record<string, string | number>) => string): string {
  if (g.membership === 'joining') return x.joining
  if (g.membership === 'left') return x.left
  if (g.membership === 'void') return x.void
  return g.knownMembers === 1 ? x.oneMember : f(x.members, { n: g.knownMembers })
}

export function GroupListScreen({ alone = false }: { alone?: boolean }) {
  const { t, f } = useI18n()
  const x = t.groups
  const groups = useGroups()
  const decisions = useDecisions()
  const contacts = useContacts()
  const { state, send } = useNav()
  const first = state.stack[0]
  const selected = first?.kind === 'group' ? first.id : null
  const found = () => send({ type: 'push', route: { kind: 'group-found' } })
  const invites = decisions.status === 'ready' ? decisions.value.filter((d): d is Invite => d.kind === 'group-invite') : []
  const names = new Map<string, string>(contacts.status === 'ready' ? contacts.value.map((c) => [c.id, c.name ?? t.contacts.unnamed] as const) : [])
  const list = groups.status === 'ready' ? groups.value : []
  const empty = groups.status === 'ready' && list.length === 0 && invites.length === 0

  return (
    <>
      <ListHeader title={t.nav.groups} count={list.length > 0 ? String(list.length) : undefined} />
      <div className="flex min-h-0 flex-1 flex-col gap-5 overflow-auto px-4 pb-4">
        {groups.status === 'loading' ? <CenteredNote text={t.shell.loading} /> : null}
        {groups.status === 'error' ? <CenteredNote text={t.app.errorTitle} /> : null}
        {empty ? (
          <EmptyState
            icon={<GroupsIcon />}
            title={x.emptyTitle}
            body={x.emptyBody}
            alone={alone}
            action={
              alone ? (
                <Button size="lg" className="[&_svg]:size-[18px]" onClick={found}>
                  <PlusIcon />
                  {x.found}
                </Button>
              ) : undefined
            }
          />
        ) : null}
        {invites.length > 0 ? (
          <section aria-labelledby="groups-open" className="flex flex-none flex-col gap-2">
            <h2 id="groups-open" className="m-0 px-1 text-[11px] font-semibold tracking-[.08em] text-muted-foreground uppercase">
              {x.open}
            </h2>
            {invites.map((d) => {
              const inviter = names.get(d.inviterId) ?? t.contacts.unnamed
              const title = d.groupName ?? f(t.decision['group-invite'].titleUnknown, { name: inviter })
              return (
                // the invitation is answered on its card in the conversation with the inviter
                <button
                  key={d.id}
                  type="button"
                  onClick={() => send({ type: 'open', route: { kind: 'chat', key: `c:${d.inviterId}` } })}
                  className="flex w-full min-w-0 items-center gap-3 rounded-lg border border-[color-mix(in_oklab,var(--warning)_45%,var(--border))] bg-card px-3.5 py-3 text-left text-inherit transition-colors hover:bg-muted"
                >
                  <PersonAvatar name={title} shape="square" />
                  <span className="flex min-w-0 flex-1 flex-col">
                    <span className="truncate text-sm font-semibold">{title}</span>
                    <span className="truncate text-[13px] text-muted-foreground">{f(t.decision['group-invite'].sub, { name: inviter })}</span>
                  </span>
                  <span className="flex flex-none items-center gap-0.5 text-[13px] font-medium text-warning">
                    {x.respond}
                    <ChevronRightIcon className="size-4" />
                  </span>
                </button>
              )
            })}
          </section>
        ) : null}
        {list.length > 0 ? (
          <div className="flex-none divide-y divide-border overflow-hidden rounded-lg border border-border bg-card">
            {list.map((g) => (
              <ConversationRow
                key={g.id}
                kind="group"
                name={g.name}
                time=""
                preview={groupLine(g, x, f)}
                pending={false}
                unread={0}
                selected={selected === g.id}
                onSelect={() => send({ type: 'open', route: { kind: 'group', id: g.id } })}
              />
            ))}
          </div>
        ) : null}
      </div>
      {alone && empty ? null : <FooterAction icon={<PlusIcon />} label={x.found} onClick={found} />}
    </>
  )
}
