import type { TrustState, Verification } from '../../port'
import { useI18n } from '../../i18n'
import { cn } from '../primitives'
import { PersonAvatar } from './PersonAvatar'
import { BlockedBadge, TrustBadge, VerificationBadge } from './StatusBadges'

export interface ConversationRowProps {
  name: string
  verification?: Verification
  trust?: TrustState
  /** "group" draws the rounded-square avatar */
  kind: 'contact' | 'group'
  time: string
  preview: string
  /** an open decision waits in this conversation: amber preview and dot */
  pending: boolean
  unread: number
  selected?: boolean
  /** blocked on this device: a badge, no preview of their messages (the adapter shows none) */
  blocked?: boolean
  onSelect?: () => void
}

/** A messenger row: avatar, name with status badges, time, preview, unread count or pending dot. */
export function ConversationRow(p: ConversationRowProps) {
  const { t, f } = useI18n()
  return (
    <button
      type="button"
      onClick={p.onSelect}
      aria-current={p.selected ? 'true' : undefined}
      className={cn(
        'flex w-full items-center gap-3 px-3.5 py-3 text-left text-inherit transition-colors hover:bg-muted',
        p.selected && 'bg-accent hover:bg-accent',
      )}
    >
      <PersonAvatar name={p.name} shape={p.kind === 'group' ? 'square' : 'circle'} dashed={p.verification === 'introduced'} />
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="flex min-w-0 items-center gap-1.5">
          <span className="min-w-0 truncate font-semibold">{p.name}</span>
          {p.verification ? <VerificationBadge verification={p.verification} /> : null}
          {p.blocked ? <BlockedBadge /> : p.trust ? <TrustBadge trust={p.trust} /> : null}
          <span className={cn('ml-auto shrink-0 pl-1.5 text-xs', p.unread > 0 ? 'text-primary' : 'text-muted-foreground')}>
            {p.time}
          </span>
        </span>
        <span className="flex min-w-0 items-center gap-2">
          <span className={cn('min-w-0 flex-1 truncate text-[13px]', p.pending ? 'text-warning-strong' : 'text-muted-foreground')}>
            {p.preview}
          </span>
          {p.unread > 0 ? (
            <span className="flex h-5 min-w-5 shrink-0 items-center justify-center rounded-full bg-primary px-1.5 text-[11px] font-bold text-primary-foreground">
              <span aria-hidden>{p.unread}</span>
              <span className="sr-only">{f(t.contacts.unread, { count: p.unread })}</span>
            </span>
          ) : p.pending ? (
            <span title={t.contacts.decisionOpen} className="size-[9px] shrink-0 rounded-full bg-warning">
              <span className="sr-only">{t.contacts.decisionOpen}</span>
            </span>
          ) : null}
        </span>
      </span>
    </button>
  )
}
