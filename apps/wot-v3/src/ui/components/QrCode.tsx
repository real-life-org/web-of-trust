// A real, scannable QR code as SVG (the prototype draws decoration only; architecture §7.4
// "QR-Rundreise"). Error correction L; one path of dark modules with a four-module quiet zone.
import { useMemo } from 'react'
import { create } from 'qrcode'

/** Every code the app draws is shown on a screen, never printed and never covered by a logo: nothing
 *  damages it, so the reserve of level M is wasted there, and level L keeps the version low and the
 *  modules large (the link of shared-connect: version 18-19 instead of 21-22). */
export const QR_ERROR_CORRECTION = 'L'

/** The code for `value`, or null when no QR version holds it (a card link with the largest free text,
 *  #439): the caller then shows the text path instead. */
export function qrPath(value: string): { readonly size: number; readonly d: string; readonly version: number } | null {
  let qr: ReturnType<typeof create>
  try {
    qr = create(value, { errorCorrectionLevel: QR_ERROR_CORRECTION })
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

/** White card with the code; `label` is the accessible name (the code itself is not read out). The
 *  module should be as large as the screen allows (architecture §5.3): on a phone the card takes the
 *  page's side gutter as well (`-mx-5`, the gutter of `FlowPage`), since the code's own white quiet zone
 *  of four modules is its margin, so on a screen of 360 points the code is 360 px wide; it stops at
 *  380 px. The card has no padding of its own and only a slight rounding, which stays inside the
 *  quiet zone, so the zone keeps its four modules in the dark theme too. A value no QR holds shows
 *  `tooLarge` instead. */
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
    <div className="-mx-5 w-[calc(100%+2.5rem)] max-w-[380px] flex-none overflow-hidden rounded-md border border-border bg-white shadow-xs">
      <svg role="img" aria-label={label} viewBox={`0 0 ${n} ${n}`} shapeRendering="crispEdges" className="block aspect-square h-auto w-full">
        <rect width={n} height={n} fill="#fff" />
        <path d={d} fill="#000" />
      </svg>
    </div>
  )
}
