import { useState, useEffect, useCallback } from 'react'
import { Key, Copy, Check, AlertTriangle, Shield, Eye, EyeOff, Sparkles } from 'lucide-react'
import { WotIdentity, type Profile } from '@real-life/wot-core'
import { ProgressIndicator, SecurityChecklist, InfoTooltip, AvatarUpload } from '../shared'
import { useLanguage } from '../../i18n'

type OnboardingStep = 'generate' | 'display' | 'verify' | 'profile' | 'protect' | 'complete'

interface OnboardingFlowProps {
  onComplete: (identity: WotIdentity, did: string, initialProfile?: Profile) => void
}

export function OnboardingFlow({ onComplete }: OnboardingFlowProps) {
  const { t, fmt } = useLanguage()
  const [step, setStepRaw] = useState<OnboardingStep>('generate')

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

      const identity = new WotIdentity()
      // WICHTIG: storeSeed=false - erst speichern wenn User Passwort gesetzt hat
      const result = await identity.create('', false)

      setMnemonic(result.mnemonic)
      setDid(result.did)

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

      const identity = new WotIdentity()
      await identity.unlock(mnemonic, passphrase, true)

      goToStep('complete')

      // Complete onboarding — pass profile data for Evolu storage
      const profile: Profile = {
        name: displayName.trim(),
        ...(bio.trim() ? { bio: bio.trim() } : {}),
        ...(avatar ? { avatar } : {}),
      }
      setTimeout(() => {
        onComplete(identity, did, profile)
      }, 2000)
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
            <div className="w-16 h-16 bg-blue-100 rounded-full flex items-center justify-center mx-auto mb-4">
              <Sparkles className="w-8 h-8 text-blue-600" />
            </div>
            <h1 className="text-3xl font-bold text-slate-900 mb-2">{t.onboarding.welcomeTitle}</h1>
            <p className="text-slate-600 text-lg">
              {t.onboarding.welcomeSubtitle}
            </p>
          </div>

          <div className="bg-blue-50 border border-blue-200 rounded-lg p-4 space-y-3">
            <h3 className="font-medium text-blue-900 flex items-center space-x-2">
              <Shield className="w-5 h-5" />
              <span>{t.onboarding.whatHappensTitle}</span>
            </h3>
            <ol className="space-y-2 text-sm text-blue-800 ml-7">
              <li>{t.onboarding.whatHappens1}</li>
              <li>{t.onboarding.whatHappens2}</li>
              <li>{t.onboarding.whatHappens3}</li>
              <li>{t.onboarding.whatHappens4}</li>
            </ol>
          </div>

          <div className="bg-yellow-50 border border-yellow-200 rounded-lg p-4">
            <div className="flex items-start space-x-3">
              <AlertTriangle className="w-5 h-5 text-yellow-600 flex-shrink-0 mt-0.5" />
              <div className="text-sm text-yellow-800">
                <strong>{t.onboarding.importantNoticeLabel}</strong> {t.onboarding.importantNoticeText}
              </div>
            </div>
          </div>

          {error && (
            <div className="p-3 bg-red-50 border border-red-200 rounded-lg text-red-700 text-sm">
              {error}
            </div>
          )}

          <button
            onClick={handleGenerate}
            disabled={isLoading}
            className="w-full py-3 bg-blue-600 text-white font-medium rounded-lg hover:bg-blue-700 transition-colors disabled:opacity-50"
            autoFocus
          >
            {isLoading ? t.onboarding.generating : t.onboarding.generateButton}
          </button>
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
            <div className="w-16 h-16 bg-yellow-100 rounded-full flex items-center justify-center mx-auto mb-4">
              <AlertTriangle className="w-8 h-8 text-yellow-600" />
            </div>
            <h1 className="text-3xl font-bold text-slate-900 mb-2">
              {t.onboarding.magicWordsTitle}
              <InfoTooltip content={t.onboarding.magicWordsTooltip} />
            </h1>
            <p className="text-slate-600">
              {t.onboarding.magicWordsInstruction}
            </p>
          </div>

          <div className="bg-slate-50 border-2 border-slate-200 rounded-lg p-6">
            <div className="grid grid-cols-3 gap-3">
              {mnemonic.split(' ').map((word, i) => (
                <div key={i} className="flex items-center space-x-2">
                  <span className="text-slate-500 text-sm w-6">{i + 1}.</span>
                  <span className="font-mono font-medium text-slate-900">{word}</span>
                </div>
              ))}
            </div>
          </div>

          <button
            onClick={handleCopyMnemonic}
            className="w-full py-3 border-2 border-slate-300 text-slate-700 font-medium rounded-lg hover:bg-slate-50 transition-colors flex items-center justify-center space-x-2"
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

          <div className="bg-red-50 border border-red-200 rounded-lg p-4 text-sm text-red-700">
            <strong>{t.onboarding.lastWarningLabel}</strong> {t.onboarding.lastWarningText}
          </div>

          <button
            onClick={() => goToStep('verify')}
            disabled={!checklistItems.every((item) => item.checked)}
            className="w-full py-3 bg-blue-600 text-white font-medium rounded-lg hover:bg-blue-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
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
            <h1 className="text-3xl font-bold text-slate-900 mb-2">{t.onboarding.verifyTitle}</h1>
            <p className="text-slate-600">
              {t.onboarding.verifyInstruction}
            </p>
          </div>

          <div className="space-y-4">
            {verifyWords.map((v) => (
              <div key={v.index}>
                <label className="block text-sm font-medium text-slate-700 mb-1">
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
                  className="w-full px-4 py-3 border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
                  placeholder={t.onboarding.wordPlaceholder}
                  autoComplete="off"
                  autoFocus={v.index === verifyWords[0].index}
                />
              </div>
            ))}

            {error && (
              <div className="p-3 bg-red-50 border border-red-200 rounded-lg text-red-700 text-sm">
                {error}
              </div>
            )}

            <button
              onClick={handleVerify}
              disabled={verifyWords.some((v) => !verifyInput[v.index]?.trim())}
              className="w-full py-3 bg-blue-600 text-white font-medium rounded-lg hover:bg-blue-700 transition-colors disabled:opacity-50"
            >
              {t.onboarding.verifyButton}
            </button>

            <button
              onClick={() => history.back()}
              className="w-full py-2 text-slate-600 hover:text-slate-900 text-sm"
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
            <h1 className="text-3xl font-bold text-slate-900 mb-2">{t.onboarding.profileTitle}</h1>
            <p className="text-slate-600">
              {t.onboarding.profileSubtitle}
            </p>
          </div>

          <AvatarUpload name={displayName} avatar={avatar} onAvatarChange={setAvatar} />

          <div className="space-y-4">
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">{t.onboarding.profileNameLabel}</label>
              <input
                type="text"
                value={displayName}
                onChange={(e) => setDisplayName(e.target.value)}
                className="w-full px-4 py-3 border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
                placeholder={t.onboarding.profileNamePlaceholder}
                autoFocus
              />
            </div>

            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">{t.onboarding.profileAboutLabel}</label>
              <textarea
                value={bio}
                onChange={(e) => setBio(e.target.value)}
                className="w-full px-4 py-3 border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 text-sm"
                rows={3}
                placeholder={t.onboarding.profileAboutPlaceholder}
              />
            </div>
          </div>

          <button
            onClick={() => goToStep('protect')}
            className="w-full py-3 bg-blue-600 text-white font-medium rounded-lg hover:bg-blue-700 transition-colors"
          >
            {t.common.next}
          </button>

          <button
            onClick={() => goToStep('protect')}
            className="w-full py-2 text-slate-500 hover:text-slate-700 text-sm transition-colors"
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
            <div className="w-16 h-16 bg-green-100 rounded-full flex items-center justify-center mx-auto mb-4">
              <Key className="w-8 h-8 text-green-600" />
            </div>
            <h1 className="text-3xl font-bold text-slate-900 mb-2">
              {t.onboarding.protectTitle}
              <InfoTooltip content={t.onboarding.protectTooltip} />
            </h1>
            <p className="text-slate-600">
              {t.onboarding.protectSubtitle}
            </p>
          </div>

          <div className="bg-blue-50 border border-blue-200 rounded-lg p-4 text-sm text-blue-800">
            <strong>{t.onboarding.tipLabel}</strong> {t.onboarding.tipText}
          </div>

          <div className="space-y-4">
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">{t.common.passwordLabel}</label>
              <div className="relative">
                <input
                  type={showPassphrase ? 'text' : 'password'}
                  value={passphrase}
                  onChange={(e) => setPassphrase(e.target.value)}
                  className="w-full px-4 py-3 border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
                  placeholder={t.common.passwordPlaceholder}
                  autoFocus
                />
                <button
                  type="button"
                  onClick={() => setShowPassphrase(!showPassphrase)}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600"
                >
                  {showPassphrase ? <EyeOff size={20} /> : <Eye size={20} />}
                </button>
              </div>
            </div>

            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">
                {t.common.passwordConfirmLabel}
              </label>
              <input
                type={showPassphrase ? 'text' : 'password'}
                value={passphraseConfirm}
                onChange={(e) => setPassphraseConfirm(e.target.value)}
                className="w-full px-4 py-3 border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
                placeholder={t.common.passwordConfirmPlaceholder}
              />
            </div>

            {error && (
              <div className="p-3 bg-red-50 border border-red-200 rounded-lg text-red-700 text-sm">
                {error}
              </div>
            )}

            <button
              onClick={handleProtect}
              disabled={isLoading || !passphrase || !passphraseConfirm}
              className="w-full py-3 bg-blue-600 text-white font-medium rounded-lg hover:bg-blue-700 transition-colors disabled:opacity-50"
            >
              {isLoading ? t.onboarding.protecting : t.onboarding.protectButton}
            </button>
          </div>
        </div>
      )}

      {/* Step 5: Complete */}
      {step === 'complete' && (
        <div className="space-y-6 text-center">
          <div className="w-16 h-16 bg-green-100 rounded-full flex items-center justify-center mx-auto">
            <Check className="w-8 h-8 text-green-600" />
          </div>
          <h1 className="text-3xl font-bold text-slate-900">{t.onboarding.completeTitle}</h1>
          <p className="text-slate-600">{t.onboarding.completeSubtitle}</p>
          <div className="bg-slate-50 border border-slate-200 rounded-lg p-4">
            <p className="text-sm text-slate-600 mb-2">{t.onboarding.yourDid}</p>
            <p className="font-mono text-xs text-slate-900 break-all">{did}</p>
          </div>
          <div className="animate-pulse text-slate-500 text-sm">
            {t.onboarding.redirecting}
          </div>
        </div>
      )}
    </div>
  )
}
