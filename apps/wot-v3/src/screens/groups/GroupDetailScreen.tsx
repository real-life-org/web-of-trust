// A group's details (prototype "Gruppendetail", Anton 22.11.): who is in it, through whom each member
// came in, under which name this person appears there, inviting a contact, leaving. The group's log
// states every line here; a member that is a contact opens that contact.
//
// Not shown yet: admissions waiting for vouchers (no group asks for vouchers: the library founds none
// that does) and a conversation (the library has no content in groups).
import { useRef, useState } from 'react'
import type { GroupDetail, GroupId, GroupInviter, GroupMember } from '../../port'
import { useGroup, useNav, usePort } from '../../hooks'
import { useI18n } from '../../i18n'
import type { Translations } from '../../i18n/types'
import { DialogDescription, DialogTitle, Sheet, SheetContent } from '../../ui/primitives'
import { ActionList, Callout, CenteredNote, ChevronLeftIcon, ChevronRightIcon, ContactsIcon, DetailLine, DetailSection, PersonAvatar, PersonIcon, PlusIcon, PrimaryAction, QuietAction } from '../../ui/components'
import { groupLine } from './GroupListScreen'

type F = (s: string, v: Record<string, string | number>) => string

/** A member's name as this person sees it: the contact's or the card's name, else the short form of its key. */
const nameOf = (m: { name: string | null; handle: string }, x: Translations['groups'], f: F): string => m.name ?? f(x.memberHandle, { handle: m.handle })

/** Through whom a member came in, as one line; null where the group does not tell. Two inviters where
 *  two members admitted the same person at once. */
export function provenanceLine(m: GroupMember, x: Translations['groups'], f: F): string | null {
  if (m.invitedBy === null) return null
  if (m.invitedBy.length === 0) return m.self ? x.youFounded : x.founded
  const who = (i: GroupInviter) => (i.self ? x.you : nameOf(i, x, f))
  const names = m.invitedBy.map(who)
  const joined = names.length === 1 ? names[0]! : `${names.slice(0, -1).join(', ')} ${x.and} ${names.at(-1)!}`
  return f(m.self ? x.youInvitedBy : x.invitedBy, { names: joined })
}

export function GroupDetailScreen({ groupId }: { groupId: GroupId }) {
  const { t } = useI18n()
  const group = useGroup(groupId)
  const { send } = useNav()
  if (group.status !== 'ready' || group.value === null) {
    return <CenteredNote text={group.status === 'loading' ? t.shell.loading : t.groups.notFound} />
  }
  return <GroupDetailView group={group.value} onBack={() => send({ type: 'back' })} />
}

export function GroupDetailView({ group: g, onBack }: { group: GroupDetail; onBack: () => void }) {
  const { t, f } = useI18n()
  const x = t.groups
  const port = usePort()
  const { send } = useNav()
  const heading = useRef<HTMLHeadingElement>(null)
  const [leaving, setLeaving] = useState(false)
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState(false)
  const self = g.visibleMembers.find((m) => m.self)
  const selfLine = self ? provenanceLine(self, x, f) : null
  const others = g.visibleMembers.filter((m) => !m.self)
  const leave = async () => {
    setBusy(true)
    setFailed(false)
    try {
      const r = await port.trust.leaveGroup(g.id).done
      if (r.ok) setLeaving(false)
      else setFailed(true)
    } finally {
      setBusy(false)
    }
  }
  return (
    <section aria-label={g.name} className="flex min-h-0 flex-1 flex-col bg-background text-foreground">
      <header className="flex flex-none items-center gap-2 px-3 pt-3 pb-2">
        <button type="button" onClick={onBack} aria-label={t.nav.back} className="hit-target relative flex size-11 flex-none items-center justify-center rounded-md hover:bg-muted md:size-9">
          <ChevronLeftIcon className="size-5" />
        </button>
        <h1 className="m-0 truncate text-[15px] font-semibold">{g.name}</h1>
      </header>
      <div className="min-h-0 flex-1 overflow-auto">
        <div className="mx-auto flex w-full max-w-[640px] flex-col gap-5 px-4 pt-2 pb-6">
          <div className="flex flex-col items-center gap-2 pt-2 pb-1 text-center">
            <PersonAvatar name={g.name} size={56} shape="square" />
            <h2 ref={heading} tabIndex={-1} className="m-0 text-xl font-bold tracking-[-0.01em] outline-none">
              {g.name}
            </h2>
            <p className="m-0 text-sm text-muted-foreground">{groupLine(g, x, f)}</p>
          </div>
          {self && g.membership === 'member' ? (
            <DetailSection title={x.youHere} icon={<PersonIcon />}>
              <DetailLine main={f(x.appearAs, { name: nameOf(self, x, f) })} sub={selfLine} />
            </DetailSection>
          ) : null}
          {others.length > 0 ? (
            <section aria-labelledby={`${g.id}-members`} className="flex flex-none flex-col gap-2">
              <h2 id={`${g.id}-members`} className="m-0 flex items-center justify-between px-1 text-[11px] font-semibold tracking-[.08em] text-muted-foreground uppercase">
                <span>{x.membersTitle}</span>
                <span>{g.visibleMembers.length}</span>
              </h2>
              <ul className="m-0 flex list-none flex-col divide-y divide-border overflow-hidden rounded-lg border border-border bg-card p-0">
                {others.map((m) => {
                  const name = nameOf(m, x, f)
                  const line = provenanceLine(m, x, f)
                  const body = (
                    <>
                      <PersonAvatar name={name} size={38} />
                      <span className="flex min-w-0 flex-1 flex-col">
                        <span className="flex min-w-0 items-center gap-1.5 text-sm font-medium">
                          <span className="truncate">{name}</span>
                          {m.contactId ? <ContactsIcon className="size-3.5 flex-none text-muted-foreground" aria-label={x.isContact} /> : null}
                        </span>
                        {line ? <span className="truncate text-xs text-muted-foreground">{line}</span> : null}
                      </span>
                    </>
                  )
                  return (
                    <li key={m.member}>
                      {m.contactId ? (
                        // a member this person knows as a contact: its details
                        <button
                          type="button"
                          onClick={() => send({ type: 'push', route: { kind: 'contact', id: m.contactId! } })}
                          className="flex w-full min-w-0 items-center gap-3 px-3.5 py-2.5 text-left text-inherit transition-colors hover:bg-muted"
                        >
                          {body}
                          <ChevronRightIcon className="size-4 flex-none text-muted-foreground" />
                        </button>
                      ) : (
                        <div className="flex min-w-0 items-center gap-3 px-3.5 py-2.5">{body}</div>
                      )}
                    </li>
                  )
                })}
              </ul>
            </section>
          ) : null}
          <ActionList
            rows={[
              ...(g.actions.invite.ok ? [{ icon: <PlusIcon />, label: x.invite, onClick: () => send({ type: 'push', route: { kind: 'group-invite', id: g.id } }) }] : []),
              ...(g.actions.leave.ok ? [{ icon: <ChevronLeftIcon />, label: x.leave, tone: 'destructive' as const, onClick: () => setLeaving(true) }] : []),
            ]}
          />
        </div>
      </div>
      <Sheet open={leaving} onOpenChange={(o) => (!o ? setLeaving(false) : undefined)}>
        <SheetContent
          className="flex flex-col gap-4"
          onCloseAutoFocus={(e) => {
            e.preventDefault()
            heading.current?.focus()
          }}
        >
          <DialogTitle className="m-0 text-lg leading-snug font-bold text-balance">{f(x.leaveTitle, { group: g.name })}</DialogTitle>
          <DialogDescription className="m-0 text-sm text-pretty text-muted-foreground">{x.leaveBody}</DialogDescription>
          {failed ? (
            <Callout tone="danger" role="alert">
              {x.failed}
            </Callout>
          ) : null}
          <div className="flex flex-col gap-2">
            <PrimaryAction label={x.leaveConfirm} variant="destructive" busy={busy} onClick={() => void leave()} />
            <QuietAction label={t.common.cancel} onClick={() => setLeaving(false)} />
          </div>
        </SheetContent>
      </Sheet>
    </section>
  )
}
