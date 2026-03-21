import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { ArrowLeft, Download, AlertCircle, CheckCircle } from 'lucide-react'
import { useAttestations } from '../../hooks'
import { useLanguage } from '../../i18n'

export function ImportAttestation() {
  const { t } = useLanguage()
  const navigate = useNavigate()
  const { importAttestation } = useAttestations()
  const [code, setCode] = useState('')
  const [isImporting, setIsImporting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [success, setSuccess] = useState(false)

  const handleImport = async () => {
    if (!code.trim()) {
      setError(t.importAttestation.errorEmptyCode)
      return
    }

    setIsImporting(true)
    setError(null)

    try {
      await importAttestation(code)
      setSuccess(true)
      setTimeout(() => {
        navigate('/attestations')
      }, 1500)
    } catch (e) {
      setError(e instanceof Error ? e.message : t.importAttestation.errorImportFailed)
    } finally {
      setIsImporting(false)
    }
  }

  if (success) {
    return (
      <div className="max-w-md mx-auto text-center py-12">
        <div className="w-16 h-16 bg-success/15 rounded-full flex items-center justify-center mx-auto mb-4">
          <CheckCircle className="w-8 h-8 text-success" />
        </div>
        <h2 className="text-xl font-bold text-foreground mb-2">{t.importAttestation.successTitle}</h2>
        <p className="text-muted-foreground">{t.importAttestation.successDescription}</p>
      </div>
    )
  }

  return (
    <div className="max-w-md mx-auto">
      <button
        onClick={() => navigate('/attestations')}
        className="flex items-center gap-2 text-muted-foreground hover:text-foreground mb-6"
      >
        <ArrowLeft size={16} />
        {t.common.back}
      </button>

      <div className="bg-card rounded-xl border border-border p-6">
        <div className="flex items-center gap-3 mb-6">
          <div className="w-10 h-10 bg-primary-100 rounded-full flex items-center justify-center">
            <Download className="w-5 h-5 text-primary-600" />
          </div>
          <div>
            <h1 className="text-lg font-bold text-foreground">{t.importAttestation.title}</h1>
            <p className="text-sm text-muted-foreground">{t.importAttestation.subtitle}</p>
          </div>
        </div>

        <div className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-foreground/80 mb-2">
              {t.importAttestation.codeLabel}
            </label>
            <textarea
              value={code}
              onChange={(e) => {
                setCode(e.target.value)
                setError(null)
              }}
              placeholder={t.importAttestation.codePlaceholder}
              className="w-full px-3 py-2 bg-card border border-border rounded-lg focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent resize-none font-mono text-sm"
              rows={6}
              disabled={isImporting}
            />
          </div>

          {error && (
            <div className="flex items-start gap-2 p-3 bg-destructive/10 border border-destructive/30 rounded-lg">
              <AlertCircle className="w-5 h-5 text-destructive flex-shrink-0 mt-0.5" />
              <p className="text-sm text-destructive">{error}</p>
            </div>
          )}

          <button
            onClick={handleImport}
            disabled={isImporting || !code.trim()}
            className="w-full py-3 bg-primary-600 text-white font-medium rounded-lg hover:bg-primary-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {isImporting ? t.importAttestation.importing : t.importAttestation.importButton}
          </button>

          <p className="text-xs text-muted-foreground text-center">
            {t.importAttestation.signatureNote}
          </p>
        </div>
      </div>
    </div>
  )
}
