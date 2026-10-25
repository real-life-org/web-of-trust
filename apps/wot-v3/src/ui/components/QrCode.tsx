// A real, scannable QR code as SVG (the prototype draws decoration only; architecture §7.4
// "QR-Rundreise"). Error correction M; one path of dark modules with a four-module quiet zone.
import { useMemo } from 'react'
import { create } from 'qrcode'

/** The code for `value`, or null when no QR version holds it (a card link with the largest free text,
 *  #439): the caller then shows the text path instead. */
export function qrPath(value: string): { readonly size: number; readonly d: string; readonly version: number } | null {
  let qr: ReturnType<typeof create>
  try {
    qr = create(value, { errorCorrectionLevel: 'M' })
  } catch {
    return null
  }
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
 *  as the screen allows (architecture §5.3). A value no QR holds shows `tooLarge` instead. */
export function QrCode({ value, label, tooLarge }: { value: string; label: string; tooLarge: string }) {
  const path = useMemo(() => qrPath(value), [value])
  if (!path) {
    return (
      <p role="status" className="m-0 w-full max-w-[326px] rounded-xl border border-border p-3 text-center text-sm text-pretty text-muted-foreground">
        {tooLarge}
      </p>
    )
  }
  const { size: n, d } = path
  return (
    <div className="w-full max-w-[326px] flex-none rounded-xl border border-border bg-white p-3 shadow-xs">
      <svg role="img" aria-label={label} viewBox={`0 0 ${n} ${n}`} shapeRendering="crispEdges" className="block aspect-square h-auto w-full">
        <rect width={n} height={n} fill="#fff" />
        <path d={d} fill="#000" />
      </svg>
    </div>
  )
}
