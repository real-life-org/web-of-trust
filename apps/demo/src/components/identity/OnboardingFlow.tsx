import { useState, useEffect, useCallback } from 'react'
import { Key, Copy, Check, AlertTriangle, Shield, Eye, EyeOff, Sparkles, Fingerprint } from 'lucide-react'
import type { IdentitySession, Profile } from '@web_of_trust/core/types'
import { ProgressIndicator, SecurityChecklist, InfoTooltip, AvatarUpload } from '../shared'
import { useLanguage } from '../../i18n'
import { BiometricService } from '../../services/BiometricService'
import { useIdentity } from '../../context/IdentityContext'
import { createIdentityWorkflow } from '../../services/identityWorkflow'

type OnboardingStep = 'generate' | 'display' | 'verify' | 'profile' | 'protect' | 'complete'

interface OnboardingFlowProps {
  onComplete: (identity: IdentitySession, did: string, initialProfile?: Profile) => void
  onRecover?: () => void
}

function generateRandomPassphrase(): string {
  const chars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789!@#$%^&*'
  const array = new Uint8Array(32)
  crypto.getRandomValues(array)
  return Array.from(array, b => chars[b % chars.length]).join('')
}

export function OnboardingFlow({ onComplete, onRecover }: OnboardingFlowProps) {
  const { t, fmt } = useLanguage()
  const { refreshBiometricStatus } = useIdentity()
  const [step, setStepRaw] = useState<OnboardingStep>('generate')
  const [biometricAvailable, setBiometricAvailable] = useState(false)

  // Push browser history on step changes so the back button works
  const goToStep = useCallback((newStep: OnboardingStep) => {
    setStepRaw(newStep)
    history.pushState({ onboardingStep: newStep }, '')
  }, [])

  // Listen for browser back/forward navigation
  useEffect(() => {
    const handlePopState = (e: PopStateEvent) => {
      if (e.state?.onboardingStep) {
        setStepRaw(e.state.onboardingStep)
      } else {
        // No onboarding state = user went back before onboarding started
        setStepRaw('generate')
      }
    }
    // Set initial state so first back press has something to return to
    history.replaceState({ onboardingStep: 'generate' }, '')
    window.addEventListener('popstate', handlePopState)
    return () => window.removeEventListener('popstate', handlePopState)
  }, [])

  const [mnemonic, setMnemonic] = useState('')
  const [did, setDid] = useState('')
  const [copied, setCopied] = useState(false)
  const [verifyWords, setVerifyWords] = useState<{ index: number; word: string }[]>([])
  const [verifyInput, setVerifyInput] = useState<Record<number, string>>({})
  const [displayName, setDisplayName] = useState('')
  const [bio, setBio] = useState('')
  const [avatar, setAvatar] = useState<string | undefined>(undefined)
  const [passphrase, setPassphrase] = useState('')
  const [passphraseConfirm, setPassphraseConfirm] = useState('')
  const [showPassphrase, setShowPassphrase] = useState(false)
  const [checklistItems, setChecklistItems] = useState([
    { id: 'written', label: t.onboarding.checklistWritten, checked: false },
    { id: 'safe', label: t.onboarding.checklistSafe, checked: false },
    { id: 'understand', label: t.onboarding.checklistUnderstand, checked: false },
  ])
  const [error, setError] = useState<string | null>(null)
  const [isLoading, setIsLoading] = useState(false)

  // Check biometric availability on mount
  useEffect(() => {
    BiometricService.isAvailable().then(setBiometricAvailable)
  }, [])

  const STEPS = [
    { label: t.onboarding.stepGenerate, description: t.onboarding.stepGenerateDesc },
    { label: t.onboarding.stepSecure, description: t.onboarding.stepSecureDesc },
    { label: t.onboarding.stepCheck, description: t.onboarding.stepCheckDesc },
    { label: t.onboarding.stepProfile, description: t.onboarding.stepProfileDesc },
    { label: t.onboarding.stepProtect, description: t.onboarding.stepProtectDesc },
  ]

  const getCurrentStepNumber = () => {
    const stepMap: Record<OnboardingStep, number> = {
      generate: 1,
      display: 2,
      verify: 3,
      profile: 4,
      protect: 5,
      complete: 5,
    }
    return stepMap[step]
  }

  const handleGenerate = async () => {
    try {
      setIsLoading(true)
      setError(null)

      // WICHTIG: storeSeed=false - erst speichern wenn User Passwort gesetzt hat
      const result = await createIdentityWorkflow().createIdentity({ passphrase: '', storeSeed: false })

      setMnemonic(result.mnemonic)
      setDid(result.identity.did)

      // Generate 3 random words for verification
      const words = result.mnemonic.split(' ')
      const indices: number[] = []
      while (indices.length < 3) {
        const idx = Math.floor(Math.random() * 12)
        if (!indices.includes(idx)) {
          indices.push(idx)
        }
      }
      setVerifyWords(indices.sort((a, b) => a - b).map((i) => ({ index: i, word: words[i] })))

      goToStep('display')
    } catch (e) {
      setError(e instanceof Error ? e.message : t.onboarding.errorGenerating)
    } finally {
      setIsLoading(false)
    }
  }

  const handleCopyMnemonic = async () => {
    await navigator.clipboard.writeText(mnemonic)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  const toggleChecklistItem = (id: string) => {
    setChecklistItems((items) =>
      items.map((item) => (item.id === id ? { ...item, checked: !item.checked } : item))
    )
  }

  const handleVerify = () => {
    const words = mnemonic.split(' ')
    const correct = verifyWords.every((v) => {
      const input = verifyInput[v.index]?.trim().toLowerCase()
      return input === v.word.toLowerCase()
    })

    if (!correct) {
      setError(t.onboarding.errorVerifyMismatch)
      return
    }

    setError(null)
    goToStep('profile')
  }

  const finishOnboarding = (identity: IdentitySession) => {
    goToStep('complete')
    const profile: Profile = {
      name: displayName.trim(),
      ...(bio.trim() ? { bio: bio.trim() } : {}),
      ...(avatar ? { avatar } : {}),
    }
    setTimeout(() => {
      onComplete(identity, did, profile)
    }, 2000)
  }

  const handleBiometricProtect = async () => {
    try {
      setIsLoading(true)
      setError(null)

      const randomPassphrase = generateRandomPassphrase()
      const { identity } = await createIdentityWorkflow().recoverIdentity({
        mnemonic,
        passphrase: randomPassphrase,
        storeSeed: true,
      })

      await BiometricService.enroll(randomPassphrase)
      await refreshBiometricStatus()

      finishOnboarding(identity)
    } catch (e) {
      // Biometric enrollment failed — fall back to password step
      setError(null)
      setIsLoading(false)
      goToStep('protect')
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

      const { identity } = await createIdentityWorkflow().recoverIdentity({ mnemonic, passphrase, storeSeed: true })

      // Also enroll biometric if available
      if (biometricAvailable) {
        try {
          await BiometricService.enroll(passphrase)
          await refreshBiometricStatus()
        } catch { /* biometric enrollment optional */ }
      }

      finishOnboarding(identity)
    } catch (e) {
      setError(e instanceof Error ? e.message : t.onboarding.errorProtecting)
    } finally {
      setIsLoading(false)
    }
  }

  return (
    <div className="max-w-2xl mx-auto p-6">
      {step !== 'generate' && step !== 'complete' && (
        <ProgressIndicator currentStep={getCurrentStepNumber()} totalSteps={5} steps={STEPS} />
      )}

      {/* Step 1: Generate */}
      {step === 'generate' && (
        <div
          className="space-y-6"
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !isLoading) {
              handleGenerate()
            }
          }}
        >
          <div className="text-center">
            <div className="w-16 h-16 bg-primary-600/15 rounded-full flex items-center justify-center mx-auto mb-4">
              <Sparkles className="w-8 h-8 text-primary-600" />
            </div>
            <h1 className="text-3xl font-bold text-foreground mb-2">{t.onboarding.welcomeTitle}</h1>
            <p className="text-muted-foreground text-lg">
              {t.onboarding.welcomeSubtitle}
            </p>
          </div>

          <div className="bg-primary-600/10 border border-primary-600/20 rounded-lg p-4 space-y-3">
            <h3 className="font-medium text-foreground flex items-center space-x-2">
              <Shield className="w-5 h-5" />
              <span>{t.onboarding.whatHappensTitle}</span>
            </h3>
            <ol className="space-y-2 text-sm text-foreground/70 ml-7">
              <li>{t.onboarding.whatHappens1}</li>
              <li>{t.onboarding.whatHappens2}</li>
              <li>{t.onboarding.whatHappens3}</li>
              <li>{t.onboarding.whatHappens4}</li>
            </ol>
          </div>

          <div className="bg-amber-600/10 border border-amber-600/20 rounded-lg p-4">
            <div className="flex items-start space-x-3">
              <AlertTriangle className="w-5 h-5 text-amber-500 flex-shrink-0 mt-0.5" />
              <div className="text-sm text-foreground/70">
                <strong className="text-amber-500">{t.onboarding.importantNoticeLabel}</strong> {t.onboarding.importantNoticeText}
              </div>
            </div>
          </div>

          {error && (
            <div className="p-3 bg-destructive/10 border border-destructive/30 rounded-lg text-destructive text-sm">
              {error}
            </div>
          )}

          <button
            onClick={handleGenerate}
            disabled={isLoading}
            className="w-full py-3 bg-primary-600 text-white font-medium rounded-xl hover:bg-primary-700 transition-colors disabled:opacity-50"
            autoFocus
          >
            {isLoading ? t.onboarding.generating : t.onboarding.generateButton}
          </button>

          {onRecover && (
            <>
              <p className="text-sm text-muted-foreground text-center">Bereits Magische Wörter?</p>
              <button
                onClick={onRecover}
                className="w-full py-3 border border-stone-300 dark:border-stone-600 text-foreground font-medium rounded-xl hover:border-primary-400 hover:bg-primary-50 dark:hover:bg-primary-950 transition-colors"
              >
                Identität importieren
              </button>
            </>
          )}
        </div>
      )}

      {/* Step 2: Display Mnemonic */}
      {step === 'display' && (
        <div
          className="space-y-6"
          onKeyDown={(e) => {
            if (e.key === 'Enter' && checklistItems.every((item) => item.checked)) {
              goToStep('verify')
            }
          }}
        >
          <div className="text-center">
            <div className="w-16 h-16 bg-amber-600/15 rounded-full flex items-center justify-center mx-auto mb-4">
              <AlertTriangle className="w-8 h-8 text-amber-500" />
            </div>
            <h1 className="text-3xl font-bold text-foreground mb-2">
              {t.onboarding.magicWordsTitle}
              <InfoTooltip content={t.onboarding.magicWordsTooltip} />
            </h1>
            <p className="text-muted-foreground">
              {t.onboarding.magicWordsInstruction}
            </p>
          </div>

          <div className="bg-card border-2 border-border rounded-lg p-6">
            <div className="grid grid-cols-3 gap-3">
              {mnemonic.split(' ').map((word, i) => (
                <div key={i} className="flex items-center space-x-2">
                  <span className="text-muted-foreground text-sm w-6">{i + 1}.</span>
                  <span className="font-mono font-medium text-foreground">{word}</span>
                </div>
              ))}
            </div>
          </div>

          <button
            onClick={handleCopyMnemonic}
            className="w-full py-3 border-2 border-border text-foreground/80 font-medium rounded-lg hover:bg-background transition-colors flex items-center justify-center space-x-2"
          >
            {copied ? (
              <>
                <Check size={20} />
                <span>{t.common.copied}</span>
              </>
            ) : (
              <>
                <Copy size={20} />
                <span>{t.onboarding.copyToClipboard}</span>
              </>
            )}
          </button>

          <SecurityChecklist items={checklistItems} onToggle={toggleChecklistItem} />

          <div className="bg-destructive/10 border border-destructive/30 rounded-lg p-4 text-sm text-destructive">
            <strong>{t.onboarding.lastWarningLabel}</strong> {t.onboarding.lastWarningText}
          </div>

          <button
            onClick={() => goToStep('verify')}
            disabled={!checklistItems.every((item) => item.checked)}
            className="w-full py-3 bg-primary-600 text-white font-medium rounded-lg hover:bg-primary-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {t.onboarding.continueToVerify}
          </button>
        </div>
      )}

      {/* Step 3: Verify */}
      {step === 'verify' && (
        <div
          className="space-y-6"
          onKeyDown={(e) => {
            if (
              e.key === 'Enter' &&
              !verifyWords.some((v) => !verifyInput[v.index]?.trim())
            ) {
              handleVerify()
            }
          }}
        >
          <div className="text-center">
            <h1 className="text-3xl font-bold text-foreground mb-2">{t.onboarding.verifyTitle}</h1>
            <p className="text-muted-foreground">
              {t.onboarding.verifyInstruction}
            </p>
          </div>

          <div className="space-y-4">
            {verifyWords.map((v) => (
              <div key={v.index}>
                <label className="block text-sm font-medium text-foreground/80 mb-1">
                  {fmt(t.onboarding.wordLabel, { number: v.index + 1 })}
                </label>
                <input
                  type="text"
                  value={verifyInput[v.index] || ''}
                  onChange={(e) =>
                    setVerifyInput({ ...verifyInput, [v.index]: e.target.value })
                  }
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault()
                      // Find next input or submit if last
                      const currentIdx = verifyWords.findIndex((w) => w.index === v.index)
                      if (currentIdx < verifyWords.length - 1) {
                        const nextInput = document.querySelector(
                          `input[value="${verifyInput[verifyWords[currentIdx + 1].index] || ''}"]`
                        ) as HTMLInputElement
                        nextInput?.focus()
                      } else if (!verifyWords.some((vw) => !verifyInput[vw.index]?.trim())) {
                        handleVerify()
                      }
                    }
                  }}
                  className="w-full px-4 py-3 bg-card border border-border rounded-lg focus:outline-none focus:ring-2 focus:ring-primary-500"
                  placeholder={t.onboarding.wordPlaceholder}
                  autoComplete="off"
                  autoFocus={v.index === verifyWords[0].index}
                />
              </div>
            ))}

            {error && (
              <div className="p-3 bg-destructive/10 border border-destructive/30 rounded-lg text-destructive text-sm">
                {error}
              </div>
            )}

            <button
              onClick={handleVerify}
              disabled={verifyWords.some((v) => !verifyInput[v.index]?.trim())}
              className="w-full py-3 bg-primary-600 text-white font-medium rounded-lg hover:bg-primary-700 transition-colors disabled:opacity-50"
            >
              {t.onboarding.verifyButton}
            </button>

            <button
              onClick={() => history.back()}
              className="w-full py-2 text-muted-foreground hover:text-foreground text-sm"
            >
              {t.onboarding.backToMagicWords}
            </button>
          </div>
        </div>
      )}

      {/* Step 4: Profile */}
      {step === 'profile' && (
        <div
          className="space-y-6"
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              goToStep('protect')
            }
          }}
        >
          <div className="text-center">
            <h1 className="text-3xl font-bold text-foreground mb-2">{t.onboarding.profileTitle}</h1>
            <p className="text-muted-foreground">
              {t.onboarding.profileSubtitle}
            </p>
          </div>

          <AvatarUpload name={displayName} avatar={avatar} onAvatarChange={setAvatar} />

          <div className="space-y-4">
            <div>
              <label className="block text-sm font-medium text-foreground/80 mb-1">{t.onboarding.profileNameLabel}</label>
              <input
                type="text"
                value={displayName}
                onChange={(e) => setDisplayName(e.target.value)}
                className="w-full px-4 py-3 bg-card border border-border rounded-lg focus:outline-none focus:ring-2 focus:ring-primary-500"
                placeholder={t.onboarding.profileNamePlaceholder}
                autoFocus
              />
            </div>

            <div>
              <label className="block text-sm font-medium text-foreground/80 mb-1">{t.onboarding.profileAboutLabel}</label>
              <textarea
                value={bio}
                onChange={(e) => setBio(e.target.value)}
                className="w-full px-4 py-3 bg-card border border-border rounded-lg focus:outline-none focus:ring-2 focus:ring-primary-500 text-sm"
                rows={3}
                placeholder={t.onboarding.profileAboutPlaceholder}
              />
            </div>
          </div>

          <button
            onClick={() => biometricAvailable ? handleBiometricProtect() : goToStep('protect')}
            disabled={isLoading}
            className="w-full py-3 bg-primary-600 text-white font-medium rounded-lg hover:bg-primary-700 transition-colors disabled:opacity-50 flex items-center justify-center gap-2"
          >
            {isLoading ? (
              t.onboarding.protecting
            ) : biometricAvailable ? (
              <><Fingerprint size={20} /><span>{t.biometric.title}</span></>
            ) : (
              t.common.next
            )}
          </button>

          <button
            onClick={() => biometricAvailable ? handleBiometricProtect() : goToStep('protect')}
            disabled={isLoading}
            className="w-full py-2 text-muted-foreground hover:text-foreground/80 text-sm transition-colors disabled:opacity-50"
          >
            {t.common.skip}
          </button>
        </div>
      )}

      {/* Step 5: Protect with Passphrase */}
      {step === 'protect' && (
        <div
          className="space-y-6"
          onKeyDown={(e) => {
            if (
              e.key === 'Enter' &&
              !isLoading &&
              passphrase &&
              passphraseConfirm &&
              passphrase === passphraseConfirm &&
              passphrase.length >= 8
            ) {
              handleProtect()
            }
          }}
        >
          <div className="text-center">
            <div className="w-16 h-16 bg-success/15 rounded-full flex items-center justify-center mx-auto mb-4">
              <Key className="w-8 h-8 text-success" />
            </div>
            <h1 className="text-3xl font-bold text-foreground mb-2">
              {t.onboarding.protectTitle}
              <InfoTooltip content={t.onboarding.protectTooltip} />
            </h1>
            <p className="text-muted-foreground">
              {t.onboarding.protectSubtitle}
            </p>
          </div>

          <div className="bg-primary-600/10 border border-primary-600/20 rounded-lg p-4 text-sm text-foreground/70">
            <strong className="text-foreground">{t.onboarding.tipLabel}</strong> {t.onboarding.tipText}
          </div>

          <div className="space-y-4">
            <div>
              <label className="block text-sm font-medium text-foreground/80 mb-1">{t.common.passwordLabel}</label>
              <div className="relative">
                <input
                  type={showPassphrase ? 'text' : 'password'}
                  value={passphrase}
                  onChange={(e) => setPassphrase(e.target.value)}
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
                className="w-full px-4 py-3 bg-card border border-border rounded-lg focus:outline-none focus:ring-2 focus:ring-primary-500"
                placeholder={t.common.passwordConfirmPlaceholder}
              />
            </div>

            {error && (
              <div className="p-3 bg-destructive/10 border border-destructive/30 rounded-lg text-destructive text-sm">
                {error}
              </div>
            )}

            <button
              onClick={handleProtect}
              disabled={isLoading || !passphrase || !passphraseConfirm}
              className="w-full py-3 bg-primary-600 text-white font-medium rounded-lg hover:bg-primary-700 transition-colors disabled:opacity-50"
            >
              {isLoading ? t.onboarding.protecting : t.onboarding.protectButton}
            </button>
          </div>
        </div>
      )}

      {/* Step 5: Complete */}
      {step === 'complete' && (
        <div className="space-y-6 text-center">
          <div className="w-16 h-16 bg-success/15 rounded-full flex items-center justify-center mx-auto">
            <Check className="w-8 h-8 text-success" />
          </div>
          <h1 className="text-3xl font-bold text-foreground">{t.onboarding.completeTitle}</h1>
          <p className="text-muted-foreground">{t.onboarding.completeSubtitle}</p>
          <div className="bg-background border border-border rounded-lg p-4">
            <p className="text-sm text-muted-foreground mb-2">{t.onboarding.yourDid}</p>
            <p className="font-mono text-xs text-foreground break-all">{did}</p>
          </div>
          <div className="animate-pulse text-muted-foreground text-sm">
            {t.onboarding.redirecting}
          </div>
        </div>
      )}
    </div>
  )
}
