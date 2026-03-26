import { useState, useEffect } from 'react'
import { WotIdentity, type Profile } from '@web.of.trust/core'
import { useIdentity } from '../../context'
import { OnboardingFlow } from './OnboardingFlow'
import { RecoveryFlow } from './RecoveryFlow'
import { UnlockFlow } from './UnlockFlow'

type Mode = 'unlock' | 'onboarding' | 'recovery'

interface IdentityManagementProps {
  onComplete: (identity: WotIdentity, did: string, initialProfile?: Profile) => void
}

export function IdentityManagement({ onComplete }: IdentityManagementProps) {
  const { hasStoredIdentity } = useIdentity()
  const [mode, setMode] = useState<Mode | null>(null)

  useEffect(() => {
    // Use hasStoredIdentity from context instead of checking again
    if (hasStoredIdentity !== null) {
      setMode(hasStoredIdentity ? 'unlock' : 'onboarding')
    }
  }, [hasStoredIdentity])

  // Still loading from context
  if (mode === null) {
    return (
      <div className="min-h-screen flex flex-col items-center justify-center gap-3">
        <div className="w-8 h-8 border-2 border-primary-200 border-t-primary-600 rounded-full animate-spin" />
        <div className="text-sm text-muted-foreground">Lade...</div>
      </div>
    )
  }

  if (mode === 'unlock') {
    return (
      <UnlockFlow
        onComplete={onComplete}
        onRecover={() => setMode('recovery')}
      />
    )
  }

  if (mode === 'recovery') {
    return (
      <RecoveryFlow
        onComplete={onComplete}
        onCancel={() => setMode(hasStoredIdentity ? 'unlock' : 'onboarding')}
      />
    )
  }

  // mode === 'onboarding'
  return (
    <div>
      <OnboardingFlow onComplete={onComplete} />
      <div className="max-w-2xl mx-auto px-6 mt-4">
        <button
          onClick={() => setMode('recovery')}
          className="w-full py-2 text-sm text-muted-foreground hover:text-foreground transition-colors"
        >
          Bereits Magische Wörter? → Identität importieren
        </button>
      </div>
    </div>
  )
}
