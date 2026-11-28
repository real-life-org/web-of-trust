// Invite a contact into a group: the contacts this person can reach and that are not in the group
// yet. The invitation goes to the contact; it is a member once it accepted and this device admitted
// it. Everyone in the group sees afterwards who invited whom.
import { useState } from 'react'
import type { ContactId, GroupId } from '../../port'
import { useContacts, useGroup, usePort } from '../../hooks'
import { useI18n } from '../../i18n'
import { Callout, CenteredNote, FlowPage, PersonAvatar, VerificationBadge } from '../../ui/components'

export function GroupInviteScreen({ groupId, onBack }: { groupId: GroupId; onBack: () => void }) {
  const { t, f } = useI18n()
  const x = t.groups
  const port = usePort()
  const group = useGroup(groupId)
  const contacts = useContacts()
  const [busy, setBusy] = useState<ContactId | null>(null)
  const [sent, setSent] = useState<readonly ContactId[]>([])
  const [failed, setFailed] = useState(false)
  if (group.status !== 'ready' || group.value === null || contacts.status !== 'ready') {
    return (
      <FlowPage title={x.invite} onBack={onBack}>
        <CenteredNote text={group.status === 'loading' || contacts.status === 'loading' ? t.shell.loading : x.notFound} />
      </FlowPage>
    )
  }
  const g = group.value
  const inGroup = new Set(g.visibleMembers.map((m) => m.contactId).filter((id): id is ContactId => id !== null))
  // a contact with a channel, not blocked, not in the group
  const open = contacts.value.filter((c) => c.channel && !c.blocked && !inGroup.has(c.id))
  const invite = async (id: ContactId) => {
    if (busy !== null) return
    setBusy(id)
    setFailed(false)
    try {
      const r = await port.trust.invite(g.id, id).done
      if (r.ok) setSent((s) => [...s, id])
      else setFailed(true)
    } finally {
      setBusy(null)
    }
  }
  return (
    <FlowPage title={f(x.inviteTitle, { group: g.name })} onBack={onBack}>
      <div className="flex flex-col gap-4">
        <p className="m-0 text-sm text-pretty text-muted-foreground">{x.inviteBody}</p>
        {failed ? (
          <Callout tone="danger" role="alert">
            {x.failed}
          </Callout>
        ) : null}
        {open.length === 0 ? (
          <p className="m-0 text-sm text-pretty text-muted-foreground">{x.inviteNobody}</p>
        ) : (
          <ul className="m-0 flex list-none flex-col divide-y divide-border overflow-hidden rounded-lg border border-border bg-card p-0">
            {open.map((c) => {
              const name = c.name ?? t.contacts.unnamed
              // invited under this id or under one joined into the contact since (an alias)
              const done = sent.includes(c.id) || c.aliases.some((a) => sent.includes(a))
              return (
                <li key={c.id} className="flex min-w-0 items-center gap-3 px-3.5 py-2.5">
                  <PersonAvatar name={name} image={c.image} size={38} />
                  <span className="flex min-w-0 flex-1 flex-col items-start gap-0.5">
                    <span className="max-w-full truncate text-sm font-medium">{name}</span>
                    <VerificationBadge verification={c.verification} />
                  </span>
                  {done ? (
                    <span className="flex-none text-[13px] text-muted-foreground">{x.invited}</span>
                  ) : (
                    <button
                      type="button"
                      disabled={busy !== null}
                      onClick={() => void invite(c.id)}
                      aria-label={f(x.inviteOne, { name })}
                      className="hit-target relative h-[34px] flex-none rounded-md border border-border bg-card px-3 text-[13px] font-medium hover:bg-muted disabled:opacity-60"
                    >
                      {x.inviteAction}
                    </button>
                  )}
                </li>
              )
            })}
          </ul>
        )}
      </div>
    </FlowPage>
  )
}
