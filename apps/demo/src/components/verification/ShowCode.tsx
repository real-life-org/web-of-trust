import { useState, useEffect } from 'react'
import { Copy, Check } from 'lucide-react'
import QRCode from 'qrcode'
import { useLanguage } from '../../i18n'

interface ShowCodeProps {
  code: string
}

export function ShowCode({ code }: ShowCodeProps) {
  const { t } = useLanguage()
  const [copied, setCopied] = useState(false)
  const [qrDataUrl, setQrDataUrl] = useState<string>('')

  // Generate QR code when code changes
  useEffect(() => {
    const generateQR = async () => {
      try {
        const dataUrl = await QRCode.toDataURL(code, {
          width: 256,
          margin: 2,
          color: {
            dark: '#1e293b', // stone-800
            light: '#ffffff',
          },
        })
        setQrDataUrl(dataUrl)
      } catch (err) {
        console.error('Failed to generate QR code:', err)
      }
    }

    if (code) {
      generateQR()
    }
  }, [code])

  const copyCode = async () => {
    await navigator.clipboard.writeText(code)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  return (
    <div className="space-y-3">
      {/* QR Code Display */}
      {qrDataUrl && (
        <div className="flex justify-center">
          <div className="bg-card rounded-lg p-4 border-2 border-border shadow-sm">
            <img src={qrDataUrl} alt={t.showCode.qrCodeAlt} className="w-64 h-64" />
          </div>
        </div>
      )}

      {/* Copy Button */}
      <div className="flex justify-center">
        <button
          onClick={copyCode}
          className="flex items-center gap-2 px-4 py-2 text-sm text-muted-foreground hover:text-foreground/80 hover:bg-muted rounded-lg transition-colors"
        >
          {copied ? (
            <>
              <Check size={16} className="text-success" />
              <span className="text-success">{t.common.copied}</span>
            </>
          ) : (
            <>
              <Copy size={16} />
              <span>{t.showCode.copyCode}</span>
            </>
          )}
        </button>
      </div>
    </div>
  )
}
