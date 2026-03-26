import { useState, useEffect, useRef } from 'react'
import { CheckCircle, XCircle, ArrowLeft, Loader2, ShieldCheck, ShieldX, X } from 'lucide-react'
import { Html5Qrcode } from 'html5-qrcode'
import { useVerification } from '../../hooks'
import type { PublicProfile } from '@web.of.trust/core'
import { Avatar } from '../shared/Avatar'
import { ShowCode } from './ShowCode'
import { ScanCode } from './ScanCode'
import { useAdapters } from '../../context'
import { useLanguage } from '../../i18n'
import { useConfetti } from '../../context/PendingVerificationContext'

type Mode = 'ready' | 'confirm' | 'success' | 'error'

export function VerificationFlow() {
  const {
    step,
    challenge,
    error,
    peerName,
    peerDid,
    createChallenge,
    prepareResponse,
    confirmAndRespond,
    reset,
  } = useVerification()
  const { discovery } = useAdapters()
  const { challengeNonce } = useConfetti()
  const { t, fmt } = useLanguage()

  const [mode, setMode] = useState<Mode>('ready')
  const [challengeCode, setChallengeCode] = useState('')
  const [peerProfile, setPeerProfile] = useState<PublicProfile | null>(null)
  const [isScanning, setIsScanning] = useState(false)
  const [scanError, setScanError] = useState<string | null>(null)
  const challengeCreated = useRef(false)
  const scannerRef = useRef<Html5Qrcode | null>(null)
  const scannerElementId = 'qr-scanner'

  // Auto-create challenge on mount
  useEffect(() => {
    if (challengeCreated.current) return
    challengeCreated.current = true

    createChallenge()
      .then((code) => setChallengeCode(code))
      .catch(() => {})
  }, [createChallenge])

  // Auto-regenerate challenge when nonce is consumed (verification came in)
  useEffect(() => {
    if (challengeNonce === null && challengeCreated.current && mode === 'ready') {
      createChallenge()
        .then((code) => setChallengeCode(code))
        .catch(() => {})
    }
  }, [challengeNonce, mode, createChallenge])

  // Cleanup scanner on unmount
  useEffect(() => {
    return () => {
      if (scannerRef.current) {
        scannerRef.current
          .stop()
          .catch((err) => console.error('Failed to stop scanner:', err))
      }
    }
  }, [])

  // Fetch peer profile from DiscoveryAdapter when entering confirm mode
  useEffect(() => {
    if (mode !== 'confirm' || !peerDid) return
    let cancelled = false
    discovery.resolveProfile(peerDid)
      .then((r) => { if (!cancelled && r.profile) setPeerProfile(r.profile) })
      .catch(() => {})
    return () => { cancelled = true }
  }, [mode, peerDid, discovery])

  // Auto-transition: step 'done' → success
  useEffect(() => {
    if (step === 'done' && (mode === 'confirm' || mode === 'ready')) {
      setMode('success')
    }
  }, [step, mode])

  const startScanning = async () => {
    try {
      setScanError(null)
      setIsScanning(true)

      // Wait for DOM to render the scanner element
      await new Promise((resolve) => setTimeout(resolve, 100))

      const scanner = new Html5Qrcode(scannerElementId)
      scannerRef.current = scanner

      await scanner.start(
        { facingMode: 'environment' },
        {
          fps: 10,
          qrbox: { width: 250, height: 250 },
        },
        (decodedText) => {
          // Successfully scanned — auto-submit
          stopScanning()
          handleScanCode(decodedText)
        },
        () => {
          // Scanning in progress (not an error)
        }
      )
    } catch (err) {
      setScanError(t.verification.cameraError)
      setIsScanning(false)
      console.error('Scanner error:', err)
    }
  }

  const stopScanning = async () => {
    if (scannerRef.current) {
      try {
        await scannerRef.current.stop()
        scannerRef.current = null
      } catch (err) {
        console.error('Failed to stop scanner:', err)
      }
    }
    setIsScanning(false)
  }

  // Scanned code → decode and show peer info for confirmation
  const handleScanCode = async (code: string) => {
    try {
      await prepareResponse(code)
      setMode('confirm')
    } catch {
      setMode('error')
    }
  }

  // Confirm → create verification + send
  const handleConfirm = async () => {
    try {
      await confirmAndRespond()
      setMode('success')
    } catch {
      setMode('error')
    }
  }

  const handleReset = () => {
    stopScanning()
    reset()
    setMode('ready')
    setChallengeCode('')
    setPeerProfile(null)
    setScanError(null)
    challengeCreated.current = false
    // Re-create challenge
    createChallenge()
      .then((code) => {
        setChallengeCode(code)
        challengeCreated.current = true
      })
      .catch(() => {})
  }

  if (mode === 'ready') {
    return (
      <div className="space-y-6">
        <div className="text-center">
          <h2 className="text-2xl font-bold text-foreground">{t.verification.title}</h2>
          <p className="text-sm text-muted-foreground mt-1">
            {t.verification.subtitle}
          </p>
        </div>

        {/* QR Code or Scanner — same area */}
        {isScanning ? (
          <div className="relative">
            <div id={scannerElementId} className="rounded-lg overflow-hidden" />
            <button
              type="button"
              onClick={stopScanning}
              className="absolute top-2 right-2 p-2 bg-destructive text-white rounded-lg hover:bg-destructive transition-colors shadow-lg"
              aria-label={t.aria.closeScanner}
            >
              <X size={20} />
            </button>
          </div>
        ) : challengeCode ? (
          <ShowCode code={challengeCode} />
        ) : (
          <div className="flex items-center justify-center py-12">
            <Loader2 className="w-6 h-6 animate-spin text-muted-foreground/70" />
          </div>
        )}

        {scanError && (
          <div className="p-3 bg-destructive/10 border border-destructive/30 rounded-lg text-destructive text-sm">
            {scanError}
          </div>
        )}

        {/* Divider + Scanner controls (only when not scanning) */}
        {!isScanning && (
          <>
            <div className="flex items-center gap-3">
              <div className="flex-1 h-px bg-border" />
              <span className="text-sm text-muted-foreground/70">{t.common.or}</span>
              <div className="flex-1 h-px bg-border" />
            </div>

            <ScanCode onSubmit={handleScanCode} onStartScan={startScanning} />
          </>
        )}
      </div>
    )
  }

  if (mode === 'confirm') {
    return (
      <div className="space-y-6">
        <button
          onClick={handleReset}
          className="flex items-center gap-2 text-muted-foreground hover:text-foreground transition-colors"
        >
          <ArrowLeft size={18} />
          {t.common.cancel}
        </button>

        <div className="text-center space-y-4">
          <h3 className="text-lg font-bold text-foreground">
            {t.verification.confirmQuestion}
          </h3>

          <div className="flex flex-col items-center gap-3 py-4">
            <Avatar
              name={peerProfile?.name || peerName || undefined}
              avatar={peerProfile?.avatar}
              size="lg"
            />
            <div>
              <p className="text-xl font-semibold text-foreground">
                {peerProfile?.name || peerName || t.verification.unknown}
              </p>
              {peerProfile?.bio && (
                <p className="text-sm text-muted-foreground mt-1">
                  {peerProfile.bio}
                </p>
              )}
              {peerDid && (
                <p className="text-xs text-muted-foreground/70 font-mono mt-1 max-w-[280px] truncate">
                  {peerDid}
                </p>
              )}
            </div>
          </div>

          <p className="text-sm text-muted-foreground">
            {t.verification.confirmHint}
          </p>

          <div className="flex gap-3 pt-2">
            <button
              onClick={handleReset}
              className="flex-1 flex items-center justify-center gap-2 px-4 py-3 border-2 border-destructive/30 text-destructive font-medium rounded-xl hover:bg-destructive/10 transition-colors"
            >
              <ShieldX size={18} />
              {t.common.cancel}
            </button>
            <button
              onClick={handleConfirm}
              disabled={step === 'responding'}
              className="flex-1 flex items-center justify-center gap-2 px-4 py-3 bg-success text-white font-medium rounded-xl hover:bg-success transition-colors disabled:opacity-50"
            >
              {step === 'responding' ? (
                <Loader2 size={18} className="animate-spin" />
              ) : (
                <ShieldCheck size={18} />
              )}
              {t.verification.confirmButton}
            </button>
          </div>
        </div>
      </div>
    )
  }

  if (mode === 'success') {
    return (
      <div className="text-center py-8">
          <div className="w-16 h-16 bg-success/15 rounded-full flex items-center justify-center mx-auto mb-4">
            <CheckCircle className="w-8 h-8 text-success" />
          </div>
          <h3 className="text-xl font-bold text-foreground mb-2">{t.verification.successTitle}</h3>
          <p className="text-muted-foreground mb-6">
            {peerName
              ? fmt(t.verification.successMessageNamed, { name: peerName })
              : challenge?.fromName
              ? fmt(t.verification.successMessageNamed, { name: challenge.fromName })
              : t.verification.successMessageGeneric}
          </p>

          <button
            onClick={handleReset}
            className="px-6 py-2 bg-primary-600 text-white font-medium rounded-lg hover:bg-primary-700 transition-colors"
          >
            {t.verification.verifyAnother}
          </button>
        </div>
    )
  }

  if (mode === 'error') {
    return (
      <div className="text-center py-8">
        <div className="w-16 h-16 bg-destructive/15 rounded-full flex items-center justify-center mx-auto mb-4">
          <XCircle className="w-8 h-8 text-destructive" />
        </div>
        <h3 className="text-xl font-bold text-foreground mb-2">{t.verification.errorTitle}</h3>
        <p className="text-muted-foreground mb-6">
          {error?.message || t.verification.errorMessageGeneric}
        </p>
        <button
          onClick={handleReset}
          className="px-6 py-2 bg-primary-600 text-white font-medium rounded-lg hover:bg-primary-700 transition-colors"
        >
          {t.verification.retryButton}
        </button>
      </div>
    )
  }

  return null
}
