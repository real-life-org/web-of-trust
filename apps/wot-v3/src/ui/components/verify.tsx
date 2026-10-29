// Pieces of the verify and contact screens (design prototype: verify page, contact detail).
import type { ElementType, ReactNode } from 'react'
import { useI18n } from '../../i18n'
import { Callout, PrimaryAction, QuietAction } from './identity'
import { PersonAvatar } from './PersonAvatar'

/** The dark camera area with its frame and scan line (scan line off under reduced motion). */
/** `viewportRef`: the element a web camera renders into (ScannerPort.scan target); native scanners
 *  are full screen and leave it empty. */
export function ScannerFrame({ lead, hint, children, viewportRef }: { lead: string; hint: string; children?: ReactNode; viewportRef?: (el: HTMLDivElement | null) => void }) {
  return (
    <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-4 bg-[oklch(24%_0.01_265)] p-5 text-[oklch(90%_0.01_265)]">
      <div className="text-sm">{lead}</div>
      <div aria-hidden className="relative size-[220px] overflow-hidden rounded-xl border-2 border-[oklch(72%_0.16_264)] bg-[oklch(20%_0.01_265)]">
        <div ref={viewportRef} data-scan-viewport="" className="absolute inset-0 [&_video]:!h-full [&_video]:!w-full [&_video]:object-cover" />
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

/** The one confirmation of a person (handshake UX 2.5, E4): the scanner after the scan, the shower when
 *  the bundle arrives or the sent card is taken over, the conversation and the contact as the fallback,
 *  the incoming sheet. Avatar, name, one question, "Confirm" and "Not now". `when`: 'now' while the
 *  person can be in front of you, 'met' afterwards (E6: "Did you meet {name}?"). The look is PR B's;
 *  this is the behaviour. The body and the actions are separate so a flow page keeps the actions in its
 *  footer and a sheet stacks them. */
export function PersonConfirmBody({
  name,
  when,
  position,
  failed,
  Title = 'h2',
  Description = 'p',
}: {
  name: string
  when: 'now' | 'met'
  /** "2 of 3" when more confirmations wait (2.6) */
  position?: { readonly n: number; readonly m: number } | null
  failed?: boolean
  /** a sheet passes its dialog title and description */
  Title?: ElementType
  Description?: ElementType
}) {
  const { t, f } = useI18n()
  const c = t.confirmPerson
  return (
    <div className="flex flex-col items-center gap-[18px] pt-4 text-center">
      <PersonAvatar name={name} size={56} />
      <div className="flex flex-col gap-1">
        {when === 'now' ? <div className="text-lg font-semibold text-balance">{name}</div> : null}
        <Title className="m-0 text-[22px] leading-tight font-bold tracking-[-0.02em] text-balance">{when === 'now' ? c.question : f(c.questionMet, { name })}</Title>
      </div>
      <Description className="m-0 text-sm text-pretty text-muted-foreground">{when === 'now' ? c.note : c.noteMet}</Description>
      {failed ? (
        <Callout tone="danger" role="alert">
          {c.failed}
        </Callout>
      ) : null}
      {position && position.m > 1 ? <div className="text-xs text-muted-foreground">{f(c.position, { n: position.n, m: position.m })}</div> : null}
    </div>
  )
}

export function PersonConfirmActions({ busy, onConfirm, onNotNow }: { busy?: boolean; onConfirm: () => void; onNotNow: () => void }) {
  const { t } = useI18n()
  return (
    <>
      <PrimaryAction label={t.confirmPerson.confirm} busy={busy === true} onClick={onConfirm} />
      <QuietAction label={t.confirmPerson.notNow} disabled={busy === true} onClick={onNotNow} />
    </>
  )
}
