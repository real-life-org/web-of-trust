import { useState } from 'react'
import { ArrowRight, Camera } from 'lucide-react'
import { useLanguage } from '../../i18n'

interface ScanCodeProps {
  onSubmit: (code: string) => void
  onStartScan: () => void
  isLoading?: boolean
}

export function ScanCode({
  onSubmit,
  onStartScan,
  isLoading = false,
}: ScanCodeProps) {
  const { t } = useLanguage()
  const [code, setCode] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [showManual, setShowManual] = useState(false)

  const handleManualSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    if (!code.trim()) {
      setError(t.scanCode.errorEmptyCode)
      return
    }
    setError(null)
    onSubmit(code.trim())
  }

  return (
    <div className="space-y-3">
      {/* QR Scanner Button */}
      <div className="flex justify-center">
        <button
          type="button"
          onClick={onStartScan}
          className="flex items-center gap-2 px-6 py-3 bg-primary-600 text-white font-medium rounded-xl hover:bg-primary-700 transition-colors"
        >
          <Camera size={18} />
          {t.scanCode.scanButton}
        </button>
      </div>

      {error && (
        <div className="p-3 bg-destructive/10 border border-destructive/30 rounded-lg text-destructive text-sm">
          {error}
        </div>
      )}

      {/* Manual Code Entry — Fallback */}
      <div className="flex justify-center">
        <button
          type="button"
          onClick={() => setShowManual(!showManual)}
          className="text-sm text-muted-foreground hover:text-foreground/80 transition-colors"
        >
          {showManual ? t.scanCode.hideManualEntry : t.scanCode.showManualEntry}
        </button>
      </div>

      {showManual && (
        <form onSubmit={handleManualSubmit} className="space-y-3">
          <textarea
            value={code}
            onChange={(e) => setCode(e.target.value)}
            placeholder={t.scanCode.placeholder}
            className="w-full h-24 bg-card border border-border rounded-lg p-3 text-xs font-mono text-foreground/80 resize-none focus:outline-none focus:ring-2 focus:ring-primary-500"
          />
          <button
            type="submit"
            disabled={isLoading || !code.trim()}
            className="w-full flex items-center justify-center gap-2 py-3 bg-primary-600 text-white font-medium rounded-lg hover:bg-primary-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {t.scanCode.verifyCode}
            <ArrowRight size={18} />
          </button>
        </form>
      )}
    </div>
  )
}
