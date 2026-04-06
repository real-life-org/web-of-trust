import { useState } from 'react'
import { Fingerprint } from 'lucide-react'
import { useLanguage } from '../../i18n'
import { BiometricService } from '../../services/BiometricService'
import { useIdentity } from '../../context/IdentityContext'

interface BiometricOptInProps {
  passphrase: string
  onDismiss: () => void
}

const BIOMETRIC_DISMISSED_KEY = 'biometric_opt_in_dismissed'

export function shouldShowBiometricOptIn(): boolean {
  return localStorage.getItem(BIOMETRIC_DISMISSED_KEY) !== 'true'
}

export function BiometricOptIn({ passphrase, onDismiss }: BiometricOptInProps) {
  const { t } = useLanguage()
  const { refreshBiometricStatus } = useIdentity()
  const [isEnrolling, setIsEnrolling] = useState(false)

  const handleEnable = async () => {
    try {
      setIsEnrolling(true)
      await BiometricService.enroll(passphrase)
      await refreshBiometricStatus()
      onDismiss()
    } catch {
      onDismiss()
    } finally {
      setIsEnrolling(false)
    }
  }

  const handleDismiss = () => {
    localStorage.setItem(BIOMETRIC_DISMISSED_KEY, 'true')
    onDismiss()
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
      <div className="bg-card rounded-2xl shadow-xl p-6 mx-4 max-w-sm w-full space-y-5">
        <div className="text-center">
          <div className="w-14 h-14 bg-primary-100 rounded-full flex items-center justify-center mx-auto mb-3">
            <Fingerprint className="w-7 h-7 text-primary-600" />
          </div>
          <h3 className="text-lg font-bold text-foreground">
            {t.biometric.title}
          </h3>
          <p className="text-sm text-muted-foreground mt-2">
            {t.biometric.enablePrompt}
          </p>
        </div>

        <div className="flex gap-3">
          <button
            onClick={handleDismiss}
            className="flex-1 py-2.5 border border-border text-muted-foreground font-medium rounded-lg hover:bg-muted/50 transition-colors"
          >
            {t.biometric.notNow}
          </button>
          <button
            onClick={handleEnable}
            disabled={isEnrolling}
            className="flex-1 py-2.5 bg-primary-600 text-white font-medium rounded-lg hover:bg-primary-700 transition-colors disabled:opacity-50"
          >
            {isEnrolling ? t.biometric.enrolling : t.biometric.enable}
          </button>
        </div>
      </div>
    </div>
  )
}
