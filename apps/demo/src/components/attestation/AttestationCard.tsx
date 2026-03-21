import { Award, User, Calendar, Globe, GlobeLock, Loader2, Clock, Check, CheckCheck, XCircle, RefreshCw } from 'lucide-react'
import type { Attestation } from '@real-life/wot-core'
import type { DeliveryStatus } from '../../services/AttestationService'
import { useLanguage } from '../../i18n'

interface AttestationCardProps {
  attestation: Attestation
  fromName?: string | undefined
  toName?: string | undefined
  showFrom?: boolean | undefined
  isPublic?: boolean | undefined
  onTogglePublic?: (attestationId: string, publish: boolean) => void
  deliveryStatus?: DeliveryStatus | undefined
  onRetry?: (attestationId: string) => void
}

function DeliveryIndicator({ status, onRetry, attestationId, t }: {
  status: DeliveryStatus
  onRetry?: ((id: string) => void) | undefined
  attestationId: string
  t: any
}) {
  switch (status) {
    case 'sending':
      return (
        <span className="text-primary" title={t.attestations.deliverySending}>
          <Loader2 size={16} className="animate-spin" />
        </span>
      )
    case 'queued':
      return (
        <div className="flex items-center gap-1">
          <span className="text-warning" title={t.attestations.deliveryQueued}>
            <Clock size={16} />
          </span>
          {onRetry && (
            <button
              onClick={() => onRetry(attestationId)}
              className="p-1 text-warning hover:text-warning/80 hover:bg-warning/10 rounded transition-colors"
              title={t.attestations.retryButton}
            >
              <RefreshCw size={14} />
            </button>
          )}
        </div>
      )
    case 'delivered':
      return (
        <span className="text-muted-foreground/70" title={t.attestations.deliveryDelivered}>
          <Check size={16} />
        </span>
      )
    case 'acknowledged':
      return (
        <span className="text-muted-foreground/70" title={t.attestations.deliveryAcknowledged}>
          <CheckCheck size={16} />
        </span>
      )
    case 'failed':
      return (
        <div className="flex items-center gap-1">
          <span className="text-destructive" title={t.attestations.deliveryFailed}>
            <XCircle size={16} />
          </span>
          {onRetry && (
            <button
              onClick={() => onRetry(attestationId)}
              className="p-1 text-destructive hover:text-destructive hover:bg-destructive/10 rounded transition-colors"
              title={t.attestations.retryButton}
            >
              <RefreshCw size={14} />
            </button>
          )}
        </div>
      )
  }
}

export function AttestationCard({
  attestation,
  fromName,
  toName,
  showFrom = true,
  isPublic,
  onTogglePublic,
  deliveryStatus,
  onRetry,
}: AttestationCardProps) {
  const { t, formatDate } = useLanguage()
  const shortFromDid = attestation.from.slice(0, 20) + '...'
  const shortToDid = attestation.to.slice(0, 20) + '...'

  return (
    <div className="bg-card rounded-lg border border-border p-4">
      <div className="flex items-start gap-3">
        <div className="w-10 h-10 bg-primary/10 rounded-full flex items-center justify-center flex-shrink-0">
          <Award className="w-5 h-5 text-primary" />
        </div>

        <div className="flex-1 min-w-0">
          {attestation.tags && attestation.tags.length > 0 && (
            <div className="flex items-center gap-2 mb-2">
              {attestation.tags.map((tag) => (
                <span
                  key={tag}
                  className="text-xs px-2 py-0.5 bg-muted text-muted-foreground rounded-full"
                >
                  {tag}
                </span>
              ))}
            </div>
          )}

          <p className="text-foreground mb-2">{attestation.claim}</p>

          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
            {showFrom && (
              <span className="flex items-center gap-1">
                <User size={12} />
                {t.attestations.fromLabel}{fromName || shortFromDid}
              </span>
            )}
            <span className="flex items-center gap-1">
              <User size={12} />
              {t.attestations.forLabel}{toName || shortToDid}
            </span>
            <span className="flex items-center gap-1">
              <Calendar size={12} />
              {formatDate(new Date(attestation.createdAt))}
            </span>
          </div>
        </div>

        <div className="flex items-center gap-1">
          {deliveryStatus && (
            <DeliveryIndicator
              status={deliveryStatus}
              onRetry={onRetry}
              attestationId={attestation.id}
              t={t}
            />
          )}
          {onTogglePublic && (
            <button
              onClick={() => onTogglePublic(attestation.id, !isPublic)}
              className={`p-2 rounded-lg transition-colors ${
                isPublic
                  ? 'text-success hover:text-success hover:bg-success/10'
                  : 'text-muted-foreground/70 hover:text-muted-foreground hover:bg-muted'
              }`}
              title={isPublic ? t.attestations.attestationPublicTitle : t.attestations.attestationPrivateTitle}
            >
              {isPublic ? <Globe size={18} /> : <GlobeLock size={18} />}
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
