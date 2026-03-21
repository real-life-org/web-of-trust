import { useState } from 'react'
import { KeyRound, Eye, EyeOff, Shield, AlertCircle } from 'lucide-react'
import { WotIdentity } from '@real-life/wot-core'
import { ProgressIndicator, InfoTooltip } from '../shared'
import { useLanguage } from '../../i18n'

type RecoveryStep = 'import' | 'validate' | 'protect' | 'complete'

interface RecoveryFlowProps {
  onComplete: (identity: WotIdentity, did: string) => void
  onCancel: () => void
}

export function RecoveryFlow({ onComplete, onCancel }: RecoveryFlowProps) {
  const { t, fmt } = useLanguage()
  const [step, setStep] = useState<RecoveryStep>('import')
  const [mnemonic, setMnemonic] = useState('')
  const [did, setDid] = useState('')
  const [passphrase, setPassphrase] = useState('')
  const [passphraseConfirm, setPassphraseConfirm] = useState('')
  const [showPassphrase, setShowPassphrase] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [isLoading, setIsLoading] = useState(false)

  const STEPS = [
    { label: t.recovery.stepImport, description: t.recovery.stepImportDesc },
    { label: t.recovery.stepValidate, description: t.recovery.stepValidateDesc },
    { label: t.recovery.stepProtect, description: t.recovery.stepProtectDesc },
  ]

  const getCurrentStepNumber = () => {
    const stepMap: Record<RecoveryStep, number> = {
      import: 1,
      validate: 2,
      protect: 3,
      complete: 3,
    }
    return stepMap[step]
  }

  const validateMnemonic = (text: string): boolean => {
    const words = text.trim().split(/\s+/)
    return words.length === 12 && words.every((word) => word.match(/^[a-z]+$/))
  }

  const handleValidate = async () => {
    const cleanMnemonic = mnemonic.trim().toLowerCase()
    const words = cleanMnemonic.split(/\s+/)

    if (words.length !== 12) {
      setError(t.recovery.errorExact12Words)
      return
    }

    if (!validateMnemonic(cleanMnemonic)) {
      setError(t.recovery.errorInvalidFormat)
      return
    }

    try {
      setIsLoading(true)
      setError(null)

      // Test if mnemonic is valid by trying to unlock
      const testIdentity = new WotIdentity()
      await testIdentity.unlock(cleanMnemonic, 'test-passphrase')
      const testDid = testIdentity.getDid()

      setDid(testDid)
      setMnemonic(cleanMnemonic)
      setStep('protect')
    } catch (e) {
      if (e instanceof Error && e.message.includes('Invalid mnemonic')) {
        setError(t.recovery.errorInvalidMnemonic)
      } else {
        setError(t.recovery.errorValidation)
      }
    } finally {
      setIsLoading(false)
    }
  }

  const handleProtect = async () => {
    if (passphrase.length < 8) {
      setError(t.common.passwordMinLength)
      return
    }
    if (passphrase !== passphraseConfirm) {
      setError(t.common.passwordsMismatch)
      return
    }

    try {
      setIsLoading(true)
      setError(null)

      // Delete any existing identity
      const identity = new WotIdentity()
      await identity.deleteStoredIdentity()

      await identity.unlock(mnemonic, passphrase, true)

      const recoveredDid = identity.getDid()
      setDid(recoveredDid)
      setStep('complete')

      // Complete recovery
      setTimeout(() => {
        onComplete(identity, recoveredDid)
      }, 2000)
    } catch (e) {
      setError(e instanceof Error ? e.message : t.recovery.errorRecovery)
    } finally {
      setIsLoading(false)
    }
  }

  const wordCount = mnemonic.trim().split(/\s+/).filter((w) => w).length
  const isValidWordCount = wordCount === 12

  return (
    <div className="max-w-2xl mx-auto p-6">
      {step !== 'import' && step !== 'complete' && (
        <ProgressIndicator currentStep={getCurrentStepNumber()} totalSteps={3} steps={STEPS} />
      )}

      {/* Step 1: Import */}
      {step === 'import' && (
        <div className="space-y-6">
          <div className="text-center">
            <div className="w-16 h-16 bg-primary-600/15 rounded-full flex items-center justify-center mx-auto mb-4">
              <KeyRound className="w-8 h-8 text-primary-600" />
            </div>
            <h1 className="text-3xl font-bold text-foreground mb-2">
              {t.recovery.importTitle}
              <InfoTooltip content={t.recovery.importTooltip} />
            </h1>
            <p className="text-muted-foreground">
              {t.recovery.importSubtitle}
            </p>
          </div>

          <div className="space-y-4">
            <div>
              <div className="flex items-center justify-between mb-1">
                <label className="block text-sm font-medium text-foreground/80">
                  {t.recovery.magicWordsLabel}
                </label>
                <span
                  className={`text-xs font-medium ${
                    isValidWordCount ? 'text-success' : 'text-muted-foreground/70'
                  }`}
                >
                  {fmt(t.recovery.wordCount, { count: wordCount })}
                </span>
              </div>
              <textarea
                value={mnemonic}
                onChange={(e) => setMnemonic(e.target.value.toLowerCase())}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && isValidWordCount && !isLoading) {
                    e.preventDefault()
                    handleValidate()
                  }
                }}
                className="w-full px-4 py-3 bg-card border border-border rounded-lg focus:outline-none focus:ring-2 focus:ring-primary-500 font-mono text-sm"
                rows={4}
                placeholder="word1 word2 word3 word4 word5 word6 word7 word8 word9 word10 word11 word12"
                autoFocus
              />
              <p className="mt-1 text-xs text-muted-foreground">
                {t.recovery.wordHint}
              </p>
            </div>

            {error && (
              <div className="p-3 bg-destructive/10 border border-destructive/30 rounded-lg text-destructive text-sm flex items-start space-x-2">
                <AlertCircle className="w-4 h-4 flex-shrink-0 mt-0.5" />
                <span>{error}</span>
              </div>
            )}

            <div className="bg-primary-600/10 border border-primary-600/20 rounded-lg p-4 space-y-2">
              <h3 className="text-sm font-medium text-foreground flex items-center space-x-2">
                <Shield className="w-4 h-4" />
                <span>{t.recovery.whatHappensTitle}</span>
              </h3>
              <ol className="space-y-1 text-xs text-foreground/70 ml-6">
                <li>{t.recovery.whatHappens1}</li>
                <li>{t.recovery.whatHappens2}</li>
                <li>{t.recovery.whatHappens3}</li>
              </ol>
            </div>

            <div className="flex space-x-3">
              <button
                onClick={onCancel}
                className="flex-1 py-3 border-2 border-border text-foreground/80 font-medium rounded-lg hover:bg-muted transition-colors"
              >
                {t.common.cancel}
              </button>
              <button
                onClick={handleValidate}
                disabled={isLoading || !isValidWordCount}
                className="flex-1 py-3 bg-primary-600 text-white font-medium rounded-lg hover:bg-primary-700 transition-colors disabled:opacity-50"
              >
                {isLoading ? t.recovery.validating : t.common.next}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Step 2: Protect with Passphrase */}
      {step === 'protect' && (
        <div className="space-y-6">
          <div className="text-center">
            <div className="w-16 h-16 bg-success/15 rounded-full flex items-center justify-center mx-auto mb-4">
              <Shield className="w-8 h-8 text-success" />
            </div>
            <h1 className="text-3xl font-bold text-foreground mb-2">
              {t.recovery.protectTitle}
              <InfoTooltip content={t.recovery.protectTooltip} />
            </h1>
            <p className="text-muted-foreground">
              {t.recovery.protectSubtitle}
            </p>
          </div>

          <div className="space-y-4">
            <div>
              <label className="block text-sm font-medium text-foreground/80 mb-1">
                {t.recovery.newPasswordLabel}
              </label>
              <div className="relative">
                <input
                  type={showPassphrase ? 'text' : 'password'}
                  value={passphrase}
                  onChange={(e) => setPassphrase(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && passphrase && passphraseConfirm && !isLoading) {
                      handleProtect()
                    }
                  }}
                  className="w-full px-4 py-3 bg-card border border-border rounded-lg focus:outline-none focus:ring-2 focus:ring-primary-500"
                  placeholder={t.common.passwordPlaceholder}
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

            <div>
              <label className="block text-sm font-medium text-foreground/80 mb-1">
                {t.common.passwordConfirmLabel}
              </label>
              <input
                type={showPassphrase ? 'text' : 'password'}
                value={passphraseConfirm}
                onChange={(e) => setPassphraseConfirm(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && passphrase && passphraseConfirm && !isLoading) {
                    handleProtect()
                  }
                }}
                className="w-full px-4 py-3 bg-card border border-border rounded-lg focus:outline-none focus:ring-2 focus:ring-primary-500"
                placeholder={t.common.passwordConfirmPlaceholder}
              />
            </div>

            {error && (
              <div className="p-3 bg-destructive/10 border border-destructive/30 rounded-lg text-destructive text-sm flex items-start space-x-2">
                <AlertCircle className="w-4 h-4 flex-shrink-0 mt-0.5" />
                <span>{error}</span>
              </div>
            )}

            <button
              onClick={handleProtect}
              disabled={isLoading || !passphrase || !passphraseConfirm}
              className="w-full py-3 bg-primary-600 text-white font-medium rounded-lg hover:bg-primary-700 transition-colors disabled:opacity-50"
            >
              {isLoading ? t.recovery.recovering : t.recovery.recoverButton}
            </button>
          </div>
        </div>
      )}

      {/* Step 3: Complete */}
      {step === 'complete' && (
        <div className="space-y-6 text-center">
          <div className="w-16 h-16 bg-success/15 rounded-full flex items-center justify-center mx-auto">
            <KeyRound className="w-8 h-8 text-success" />
          </div>
          <h1 className="text-3xl font-bold text-foreground">{t.recovery.completeTitle}</h1>
          <p className="text-muted-foreground">{t.recovery.completeSubtitle}</p>
          <div className="bg-card border border-border rounded-lg p-4">
            <p className="text-sm text-muted-foreground mb-2">{t.recovery.yourDid}</p>
            <p className="font-mono text-xs text-foreground break-all">{did}</p>
          </div>
          <div className="animate-pulse text-muted-foreground text-sm">
            {t.recovery.redirecting}
          </div>
        </div>
      )}
    </div>
  )
}
