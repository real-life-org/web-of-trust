// A real, scannable QR code as SVG (the prototype draws decoration only; architecture §7.4
// "QR-Rundreise"). Error correction M; one path of dark modules with a four-module quiet zone.
import { useMemo } from 'react'
import { create } from 'qrcode'

export function qrPath(value: string): { readonly size: number; readonly d: string; readonly version: number } {
  const qr = create(value, { errorCorrectionLevel: 'M' })
  const n = qr.modules.size
  const q = 4
  let d = ''
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) if (qr.modules.get(x, y)) d += `M${x + q} ${y + q}h1v1h-1z`
  }
  return { size: n + 2 * q, d, version: qr.version }
}

/** White card with the code; `label` is the accessible name (the code itself is not read out). */
export function QrCode({ value, label, size = 220 }: { value: string; label: string; size?: number }) {
  const { size: n, d } = useMemo(() => qrPath(value), [value])
  return (
    <div className="flex-none rounded-xl border border-border bg-white p-3 shadow-xs">
      <svg role="img" aria-label={label} viewBox={`0 0 ${n} ${n}`} width={size} height={size} shapeRendering="crispEdges" className="block">
        <rect width={n} height={n} fill="#fff" />
        <path d={d} fill="#000" />
      </svg>
    </div>
  )
}
