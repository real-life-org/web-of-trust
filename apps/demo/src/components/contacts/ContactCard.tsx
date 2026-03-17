import { Shield, ShieldCheck, ShieldAlert, ArrowDownLeft, ArrowUpRight, ArrowLeftRight, Trash2, Award, Users } from 'lucide-react'
import { Link } from 'react-router-dom'
import type { Contact } from '@real-life/wot-core'
import type { VerificationDirection } from '../../hooks/useVerificationStatus'
import { Avatar } from '../shared'
import { useLanguage, plural } from '../../i18n'

interface ContactCardProps {
  contact: Contact
  onRemove?: () => void
  verificationCount?: number | undefined
  attestationCount?: number
  verificationStatus?: VerificationDirection
}

export function ContactCard({ contact, onRemove, verificationCount, attestationCount = 0, verificationStatus = 'none' }: ContactCardProps) {
  const { t, fmt, formatDate } = useLanguage()

  const verificationInfo: Record<VerificationDirection, { label: string; color: string; icon: typeof Shield }> = {
    mutual: { label: t.contacts.statusMutual, color: 'bg-success/15 text-success', icon: ShieldCheck },
    incoming: { label: t.contacts.statusIncoming, color: 'bg-blue-100 text-blue-700', icon: ArrowDownLeft },
    outgoing: { label: t.contacts.statusOutgoing, color: 'bg-amber-100 text-amber-700', icon: ArrowUpRight },
    none: { label: t.contacts.statusNone, color: 'bg-muted text-muted-foreground', icon: ShieldAlert },
  }

  const statusColors = {
    pending: 'bg-yellow-100 text-yellow-700',
    active: verificationInfo[verificationStatus].color,
  }

  const statusLabels = {
    pending: t.contacts.statusPending,
    active: verificationInfo[verificationStatus].label,
  }

  const shortDid = contact.did.slice(0, 12) + '...' + contact.did.slice(-6)
  const displayName = contact.name || shortDid

  return (
    <div className="bg-card rounded-lg border border-border p-4">
      <div className="flex items-center gap-3">
        <Link to={`/p/${encodeURIComponent(contact.did)}`}>
          <Avatar name={contact.name} avatar={contact.avatar} size="sm" />
        </Link>

        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <Link to={`/p/${encodeURIComponent(contact.did)}`} className="font-medium text-foreground truncate hover:text-primary-600 transition-colors">
              {displayName}
            </Link>
            {verificationStatus !== 'none' && (
              <span className={`text-xs px-2 py-0.5 rounded-full whitespace-nowrap flex-shrink-0 flex items-center gap-1 ${statusColors[contact.status]}`}>
                {(() => { const Icon = verificationStatus === 'mutual' ? ArrowLeftRight : verificationInfo[verificationStatus].icon; return <Icon size={12} className="md:hidden" /> })()}
                <span className="hidden md:inline">{statusLabels[contact.status]}</span>
              </span>
            )}
          </div>
          {contact.status === 'active' && (
            <>
              {/* Mobile: compact */}
              <div className="flex items-center gap-3 mt-1 text-xs text-muted-foreground/70 md:hidden">
                {contact.verifiedAt && (
                  <span>{formatDate(new Date(contact.verifiedAt))}</span>
                )}
                {verificationCount != null && verificationCount > 0 && (
                  <span className="flex items-center gap-1">
                    <Users size={11} />
                    {verificationCount}
                  </span>
                )}
                {attestationCount > 0 && (
                  <span className="flex items-center gap-1">
                    <Award size={11} />
                    {attestationCount}
                  </span>
                )}
              </div>
              {/* Desktop: full labels */}
              <div className="hidden md:flex items-center gap-4 mt-1 text-xs text-muted-foreground/70">
                {contact.verifiedAt && (() => {
                  const StatusIcon = verificationInfo[verificationStatus].icon
                  return (
                    <span className="flex items-center gap-1">
                      <StatusIcon size={12} />
                      {formatDate(new Date(contact.verifiedAt))}
                    </span>
                  )
                })()}
                {verificationCount != null && verificationCount > 0 && (
                  <span className="flex items-center gap-1">
                    <Users size={12} />
                    {fmt(t.contacts.verificationCount, { count: verificationCount, label: plural(verificationCount, t.common.contactOne, t.common.contactMany) })}
                  </span>
                )}
                <span className="flex items-center gap-1">
                  <Award size={12} />
                  {fmt(t.contacts.attestationCount, { count: attestationCount, label: plural(attestationCount, t.common.attestationOne, t.common.attestationMany) })}
                </span>
              </div>
            </>
          )}
        </div>

        {contact.status === 'active' && (
          <Link
            to={`/attestations/new?to=${contact.did}`}
            className="p-2 text-muted-foreground/70 hover:text-accent-600 hover:bg-accent-50 rounded-lg transition-colors flex-shrink-0"
            title={t.contacts.createAttestationTitle}
          >
            <Award size={18} />
          </Link>
        )}

        {contact.status === 'pending' && onRemove && (
          <button
            onClick={onRemove}
            className="p-2 text-muted-foreground/70 hover:text-destructive hover:bg-destructive/10 rounded-lg transition-colors flex-shrink-0"
            title={t.contacts.removeTitle}
          >
            <Trash2 size={18} />
          </button>
        )}
      </div>
    </div>
  )
}
