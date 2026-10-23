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

/** White card with the code; `label` is the accessible name (the code itself is not read out). It takes
 *  the full width up to 300 CSS px of code (about 46 mm on a phone), so that a module stays as large
 *  as the screen allows (architecture §5.3). */
export function QrCode({ value, label }: { value: string; label: string }) {
  const { size: n, d } = useMemo(() => qrPath(value), [value])
  return (
    <div className="w-full max-w-[326px] flex-none rounded-xl border border-border bg-white p-3 shadow-xs">
      <svg role="img" aria-label={label} viewBox={`0 0 ${n} ${n}`} shapeRendering="crispEdges" className="block aspect-square h-auto w-full">
        <rect width={n} height={n} fill="#fff" />
        <path d={d} fill="#000" />
      </svg>
    </div>
  )
}
