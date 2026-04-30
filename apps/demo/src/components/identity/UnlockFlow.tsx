import { useState, useEffect, useRef } from 'react'
import { Lock, Eye, EyeOff, Fingerprint } from 'lucide-react'
import type { IdentitySession } from '@web_of_trust/core'
import { useLanguage } from '../../i18n'
import { BiometricService } from '../../services/BiometricService'
import { useIdentity } from '../../context/IdentityContext'
import { BiometricOptIn, shouldShowBiometricOptIn } from './BiometricOptIn'
import { createIdentityWorkflow } from '../../services/identityWorkflow'
import { resetLocalAppData } from '../../services/resetLocalAppData'

interface UnlockFlowProps {
  onComplete: (identity: IdentitySession, did: string) => void
  onRecover: () => void
}

export function UnlockFlow({ onComplete, onRecover }: UnlockFlowProps) {
  const { t } = useLanguage()
  const { biometricEnrolled, refreshBiometricStatus } = useIdentity()
  const [passphrase, setPassphrase] = useState('')
  const [showPassphrase, setShowPassphrase] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [isLoading, setIsLoading] = useState(false)
  const [biometricLoading, setBiometricLoading] = useState(false)
  const [showBiometricOptIn, setShowBiometricOptIn] = useState(false)
  const [unsupportedIdentity, setUnsupportedIdentity] = useState(false)
  const [pendingComplete, setPendingComplete] = useState<{ identity: IdentitySession; did: string } | null>(null)
  const biometricAttempted = useRef(false)

  const getUnlockErrorMessage = (error: Error): string => {
    if (error.message.includes('Invalid passphrase')) return t.unlock.errorWrongPassword
    if (error.message.includes('No stored seed') || error.message.includes('No identity found in storage')) {
      return t.unlock.errorNoIdentity
    }
    if (error.message.includes('unsupported legacy seed format') || error.message.includes('Invalid identity seed format')) {
      setUnsupportedIdentity(true)
      return t.unlock.errorUnsupportedIdentity
    }
    return error.message
  }

  const handleCreateNewIdentity = async () => {
    setIsLoading(true)
    try {
      await resetLocalAppData()
      window.location.href = import.meta.env.BASE_URL || '/'
    } finally {
      setIsLoading(false)
    }
  }

  // Auto-trigger biometric on mount if enrolled
  useEffect(() => {
    if (biometricEnrolled && !biometricAttempted.current) {
      biometricAttempted.current = true
      handleBiometricUnlock()
    }
  }, [biometricEnrolled])

  const handleBiometricUnlock = async () => {
    try {
      setBiometricLoading(true)
      setError(null)

      const decryptedPassphrase = await BiometricService.authenticate()

      const { identity } = await createIdentityWorkflow().unlockStoredIdentity({ passphrase: decryptedPassphrase })
      const did = identity.getDid()
      onComplete(identity, did)
    } catch (e) {
      if (e instanceof Error) {
        if (e.message.includes('USER_CANCELLED')) {
          // User cancelled — show retry + recover options
        } else if (e.message.includes('KEY_INVALIDATED')) {
          setError(t.unlock.biometricInvalidated)
          await BiometricService.unenroll()
          refreshBiometricStatus()
        } else {
          setError(getUnlockErrorMessage(e))
        }
      }
    } finally {
      setBiometricLoading(false)
    }
  }

  const handleUnlock = async () => {
    if (!passphrase) {
      setError(t.unlock.errorNoPassword)
      return
    }

    try {
      setIsLoading(true)
      setError(null)

      const { identity } = await createIdentityWorkflow().unlockStoredIdentity({ passphrase })
      const did = identity.getDid()

      // Check if we should offer biometric enrollment
      if (!biometricEnrolled && shouldShowBiometricOptIn()) {
        const available = await BiometricService.isAvailable()
        if (available) {
          setPendingComplete({ identity, did })
          setShowBiometricOptIn(true)
          return
        }
      }

      onComplete(identity, did)
    } catch (e) {
      if (e instanceof Error) {
        setError(getUnlockErrorMessage(e))
      } else {
        setError(t.unlock.errorGeneric)
      }
    } finally {
      setIsLoading(false)
    }
  }

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && passphrase) {
      handleUnlock()
    }
  }

  // Biometric-only unlock screen
  if (biometricEnrolled) {
    return (
      <div className="max-w-md mx-auto p-6">
        <div className="space-y-6">
          <div className="text-center">
            <div className="w-16 h-16 bg-primary-100 rounded-full flex items-center justify-center mx-auto mb-4">
              <Fingerprint className="w-8 h-8 text-primary-600" />
            </div>
            <h1 className="text-3xl font-bold text-foreground mb-2">
              {unsupportedIdentity ? t.unlock.unsupportedIdentityTitle : t.unlock.title}
            </h1>
            <p className="text-muted-foreground">
              {unsupportedIdentity ? t.unlock.unsupportedIdentitySubtitle : t.unlock.biometricButton}
            </p>
          </div>

          {error && (
            <div className="p-3 bg-destructive/10 border border-destructive/30 rounded-lg text-destructive text-sm">
              {error}
            </div>
          )}

          {unsupportedIdentity ? (
            <button
              onClick={handleCreateNewIdentity}
              disabled={isLoading}
              className="w-full py-3 bg-primary-600 text-white font-medium rounded-lg hover:bg-primary-700 transition-colors disabled:opacity-50"
            >
              {t.unlock.createNewIdentityButton}
            </button>
          ) : (
            <button
              onClick={handleBiometricUnlock}
              disabled={biometricLoading}
              className="w-full flex items-center justify-center gap-3 py-4 bg-primary-50 border-2 border-primary-200 text-primary-700 font-medium rounded-xl hover:bg-primary-100 transition-colors disabled:opacity-50"
            >
              <Fingerprint size={24} />
              {biometricLoading ? t.unlock.biometricUnlocking : t.unlock.biometricButton}
            </button>
          )}

          {!unsupportedIdentity && (
            <div className="text-center">
              <button
                onClick={onRecover}
                className="text-sm text-primary-600 hover:text-primary-700 hover:underline"
              >
                {t.unlock.recoverLink}
              </button>
            </div>
          )}
        </div>
      </div>
    )
  }

  // Password unlock screen (no biometric enrolled)
  return (
    <div className="max-w-md mx-auto p-6">
      <div className="space-y-6">
        <div className="text-center">
          <div className="w-16 h-16 bg-primary-100 rounded-full flex items-center justify-center mx-auto mb-4">
            <Lock className="w-8 h-8 text-primary-600" />
          </div>
          <h1 className="text-3xl font-bold text-foreground mb-2">
            {unsupportedIdentity ? t.unlock.unsupportedIdentityTitle : t.unlock.title}
          </h1>
          <p className="text-muted-foreground">
            {unsupportedIdentity ? t.unlock.unsupportedIdentitySubtitle : t.unlock.subtitle}
          </p>
        </div>

        <div className="space-y-4">
          {!unsupportedIdentity && (
            <div>
              <label className="block text-sm font-medium text-foreground/80 mb-1">
                {t.unlock.passwordLabel}
              </label>
              <div className="relative">
                <input
                  type={showPassphrase ? 'text' : 'password'}
                  value={passphrase}
                  onChange={(e) => setPassphrase(e.target.value)}
                  onKeyDown={handleKeyDown}
                  className="w-full px-4 py-3 bg-card border border-border rounded-lg focus:outline-none focus:ring-2 focus:ring-primary-500"
                  placeholder={t.unlock.passwordPlaceholder}
                  autoFocus
                />
                <button
                  type="button"
                  tabIndex={-1}
                  onClick={() => setShowPassphrase(!showPassphrase)}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground/70 hover:text-muted-foreground"
                >
                  {showPassphrase ? <EyeOff size={20} /> : <Eye size={20} />}
                </button>
              </div>
            </div>
          )}

          {error && (
            <div className="p-3 bg-destructive/10 border border-destructive/30 rounded-lg text-destructive text-sm">
              {error}
            </div>
          )}

          {unsupportedIdentity ? (
            <button
              onClick={handleCreateNewIdentity}
              disabled={isLoading}
              className="w-full py-3 bg-primary-600 text-white font-medium rounded-lg hover:bg-primary-700 transition-colors disabled:opacity-50"
            >
              {t.unlock.createNewIdentityButton}
            </button>
          ) : (
            <button
              onClick={handleUnlock}
              disabled={isLoading || !passphrase}
              className="w-full py-3 bg-primary-600 text-white font-medium rounded-lg hover:bg-primary-700 transition-colors disabled:opacity-50"
            >
              {isLoading ? t.unlock.unlocking : t.unlock.unlockButton}
            </button>
          )}

          {!unsupportedIdentity && (
            <div className="text-center">
              <button
                onClick={onRecover}
                className="text-sm text-primary-600 hover:text-primary-700 hover:underline"
              >
                {t.unlock.recoverLink}
              </button>
            </div>
          )}
        </div>
      </div>

      {showBiometricOptIn && pendingComplete && (
        <BiometricOptIn
          passphrase={passphrase}
          onDismiss={() => {
            setShowBiometricOptIn(false)
            onComplete(pendingComplete.identity, pendingComplete.did)
          }}
        />
      )}
    </div>
  )
}
