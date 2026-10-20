// Pieces of the verify and contact screens (design prototype: verify page, contact detail).
import type { ReactNode } from 'react'
import { cn } from '../primitives'

/** The dark camera area with its frame and scan line (scan line off under reduced motion). */
export function ScannerFrame({ lead, hint, children }: { lead: string; hint: string; children?: ReactNode }) {
  return (
    <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-4 bg-[oklch(24%_0.01_265)] p-5 text-[oklch(90%_0.01_265)]">
      <div className="text-sm">{lead}</div>
      <div aria-hidden className="relative size-[220px] overflow-hidden rounded-xl border-2 border-[oklch(72%_0.16_264)] bg-[oklch(20%_0.01_265)]">
        <span className="absolute inset-x-[8%] top-1/2 h-0.5 bg-[oklch(72%_0.16_264)] shadow-[0_0_12px_oklch(72%_0.16_264)] motion-safe:animate-[scanline_2.4s_ease-in-out_infinite]" />
      </div>
      <div className="max-w-[34ch] text-center text-xs text-pretty text-[oklch(70%_0.01_265)]">{hint}</div>
      {children}
    </div>
  )
}

/** A titled card section of the contact detail (prototype: uppercase label above a card). */
export function DetailSection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="flex flex-none flex-col gap-2">
      <h2 className="m-0 px-1 text-[11px] font-semibold tracking-[.08em] text-muted-foreground uppercase">{title}</h2>
      <div className="flex flex-col gap-2.5 rounded-lg border border-border bg-card px-4 py-3.5">{children}</div>
    </section>
  )
}

export function DetailLine({ main, sub }: { main: string; sub?: string | null }) {
  return (
    <>
      <p className="m-0 text-sm text-pretty">{main}</p>
      {sub ? <p className="m-0 text-xs text-pretty text-muted-foreground">{sub}</p> : null}
    </>
  )
}

/** One fact with a glyph (counter sheet). */
export function FactRow({ glyph, text, tone = 'muted' }: { glyph: string; text: string; tone?: 'primary' | 'muted' }) {
  return (
    <div className="flex items-start gap-2.5 text-[13px]">
      <span aria-hidden className={cn('w-4 flex-none text-center font-semibold', tone === 'primary' ? 'text-primary' : 'text-muted-foreground')}>
        {glyph}
      </span>
      <span className="text-pretty">{text}</span>
    </div>
  )
}

/** Confetti for a new mutual connection; nothing under reduced motion (architecture §6.5). */
export function Confetti() {
  const colors = ['var(--primary)', 'var(--success)', 'var(--warning)', 'var(--primary-300)']
  return (
    <div aria-hidden className="pointer-events-none absolute inset-0 overflow-hidden motion-reduce:hidden">
      {Array.from({ length: 28 }, (_, i) => (
        <span
          key={i}
          className="absolute -top-2.5"
          style={{
            left: `${(i * 37) % 100}%`,
            width: i % 3 ? 8 : 6,
            height: i % 2 ? 12 : 8,
            borderRadius: i % 4 ? 2 : 9999,
            background: colors[i % colors.length],
            animation: `confetti-fall ${2.2 + (i % 5) * 0.35}s ease-in ${(i % 7) * 0.12}s 1 both`,
          }}
        />
      ))}
    </div>
  )
}
