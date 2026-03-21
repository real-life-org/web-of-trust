import { useState, useEffect, useCallback } from 'react'
import { Award } from 'lucide-react'
import { Link } from 'react-router-dom'
import { useAttestations, useContacts, useProfileSync, useAttestationDelivery } from '../../hooks'
import { useIdentity, useAdapters, usePendingVerification } from '../../context'
import { AttestationCard } from './AttestationCard'
import { useLanguage } from '../../i18n'

export function AttestationList() {
  const { t, fmt } = useLanguage()
  const { myAttestations, receivedAttestations, isLoading, setAttestationAccepted } = useAttestations()
  const { contacts } = useContacts()
  const { did: myDid } = useIdentity()
  const { storage } = useAdapters()
  const { uploadVerificationsAndAttestations } = useProfileSync()
  const { incomingAttestation } = usePendingVerification()
  const { deliveryStatusMap, retryAttestation } = useAttestationDelivery()
  const [publicMap, setPublicMap] = useState<Record<string, boolean>>({})

  // Load metadata for all received attestations
  // Re-runs when attestation dialog closes (incomingAttestation → null)
  useEffect(() => {
    async function loadMetadata() {
      const map: Record<string, boolean> = {}
      for (const att of receivedAttestations) {
        const meta = await storage.getAttestationMetadata(att.id)
        map[att.id] = meta?.accepted ?? false
      }
      setPublicMap(map)
    }
    loadMetadata()
  }, [receivedAttestations, storage, incomingAttestation])

  const handleTogglePublic = useCallback(async (attestationId: string, publish: boolean) => {
    await setAttestationAccepted(attestationId, publish)
    setPublicMap(prev => ({ ...prev, [attestationId]: publish }))
    // Re-upload to profile service so public profile reflects the change
    uploadVerificationsAndAttestations()
  }, [setAttestationAccepted, uploadVerificationsAndAttestations])

  const getContactName = (did: string) => {
    if (myDid === did) return t.attestations.selfName
    const contact = contacts.find((c) => c.did === did)
    return contact?.name
  }

  if (isLoading) {
    return (
      <div className="text-center py-8 text-muted-foreground">
        {t.attestations.loading}
      </div>
    )
  }

  if (myAttestations.length === 0 && receivedAttestations.length === 0) {
    return (
      <div className="text-center py-12">
        <div className="w-16 h-16 bg-muted rounded-full flex items-center justify-center mx-auto mb-4">
          <Award className="w-8 h-8 text-muted-foreground/70" />
        </div>
        <h3 className="text-lg font-medium text-foreground mb-2">{t.attestations.emptyTitle}</h3>
        <p className="text-muted-foreground mb-4">
          {t.attestations.emptyDescription}
        </p>
        <Link
          to="/contacts"
          className="inline-flex items-center gap-2 px-4 py-2 bg-primary-600 text-white font-medium rounded-lg hover:bg-primary-700 transition-colors"
        >
          {t.attestations.goToContacts}
        </Link>
      </div>
    )
  }

  return (
    <div className="space-y-6">
      {myAttestations.length > 0 && (
        <section>
          <h2 className="text-sm font-medium text-muted-foreground uppercase tracking-wider mb-3">
            {fmt(t.attestations.createdByMeHeading, { count: myAttestations.length })}
          </h2>
          <div className="space-y-2">
            {myAttestations.map((attestation) => (
              <AttestationCard
                key={attestation.id}
                attestation={attestation}
                fromName={getContactName(attestation.from)}
                toName={getContactName(attestation.to)}
                showFrom={false}
                deliveryStatus={deliveryStatusMap.get(attestation.id)}
                onRetry={retryAttestation}
              />
            ))}
          </div>
        </section>
      )}

      {receivedAttestations.length > 0 && (
        <section>
          <h2 className="text-sm font-medium text-muted-foreground uppercase tracking-wider mb-3">
            {fmt(t.attestations.aboutMeHeading, { count: receivedAttestations.length })}
          </h2>
          <p className="text-xs text-muted-foreground/70 mb-3">
            {t.attestations.publicNote}
          </p>
          <div className="space-y-2">
            {receivedAttestations.map((attestation) => (
              <AttestationCard
                key={attestation.id}
                attestation={attestation}
                fromName={getContactName(attestation.from)}
                toName={getContactName(attestation.to)}
                isPublic={publicMap[attestation.id] ?? false}
                onTogglePublic={handleTogglePublic}
              />
            ))}
          </div>
        </section>
      )}
    </div>
  )
}
