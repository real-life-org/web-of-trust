// Pieces of the verify and contact screens (design prototype: verify page, contact detail).
import type { ElementType, ReactNode } from 'react'
import { useI18n } from '../../i18n'
import { Button, cn } from '../primitives'
import { Callout, PrimaryAction } from './identity'
import { PersonAvatar } from './PersonAvatar'
import { ClockIcon, ScanIcon } from './icons'

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

/** Confetti for a new mutual connection; nothing under reduced motion (architecture §6.5). The pieces
 *  start scattered over the top of the screen (artboard 2b) and fall from there. */
export function Confetti() {
  const colors = ['var(--primary)', 'var(--success)', 'var(--warning)', 'var(--primary-300)']
  return (
    <div aria-hidden className="pointer-events-none absolute inset-0 overflow-hidden motion-reduce:hidden">
      {Array.from({ length: 28 }, (_, i) => (
        <span
          key={i}
          className="absolute"
          style={{
            left: `${(i * 37 + 11) % 96}%`,
            top: i % 4 === 3 ? -10 : 12 + ((i * 53) % 230),
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

/** The one confirmation of a person (handshake UX 2.5, E4; look: artboards 1a–1d): the scanner after
 *  the scan, the shower when the bundle arrives or the sent card is taken over, the conversation and the
 *  contact as the fallback, the incoming sheet. Avatar, name, one question, "Confirm" and "Not now".
 *  `when`: 'now' while the person can be in front of you, 'met' afterwards (E6: "Did you meet {name}?").
 *  `scanned`: the person scanned your code (the shower's side); a pill says so above the avatar, muted
 *  with a clock once the moment is past. The body and the actions are separate so a flow page keeps the
 *  actions in its footer and a sheet stacks them. */
export function PersonConfirmBody({
  name,
  when,
  scanned = false,
  position,
  failed,
  Title = 'h2',
  Description = 'p',
}: {
  name: string
  when: 'now' | 'met'
  scanned?: boolean
  /** "2 of 3" when more confirmations wait (2.6, artboard 1d) */
  position?: { readonly n: number; readonly m: number } | null
  failed?: boolean
  /** a sheet passes its dialog title and description */
  Title?: ElementType
  Description?: ElementType
}) {
  const { t, f } = useI18n()
  const c = t.confirmPerson
  const first = firstName(name)
  // 'met' has no note (the designer's sentence is not approved): the pill is the description there
  const pill =
    scanned || when === 'met' ? (
      <span
        className={cn(
          'inline-flex items-center gap-2 rounded-full px-3 py-1.5 text-[13px] font-medium [&_svg]:size-4',
          when === 'now' ? 'bg-accent text-accent-foreground-strong' : 'bg-muted text-muted-foreground',
        )}
      >
        {when === 'now' ? <ScanIcon /> : <ClockIcon />}
        {f(c.scanned, { name: first })}
      </span>
    ) : null
  return (
    <div className="flex flex-1 flex-col items-center justify-center pb-6 text-center">
      {position && position.m > 1 ? <QueuePosition n={position.n} m={position.m} /> : null}
      {pill ? when === 'met' ? <Description className="m-0 mb-6">{pill}</Description> : <p className="m-0 mb-6">{pill}</p> : null}
      <PersonAvatar name={name} size={112} />
      <p className="m-0 mt-4 text-2xl leading-tight font-bold tracking-[-0.01em] text-balance">{name}</p>
      <Title className="m-0 mt-7 text-lg leading-snug font-semibold text-balance">{when === 'now' ? c.question : f(c.questionMet, { name })}</Title>
      {when === 'now' ? <Description className="m-0 mt-2 max-w-[30ch] text-sm text-pretty text-muted-foreground">{c.note}</Description> : null}
      {failed ? (
        <div className="mt-5 w-full text-left">
          <Callout tone="danger" role="alert">
            {c.failed}
          </Callout>
        </div>
      ) : null}
    </div>
  )
}

/** "2 of 3" with one bar per waiting confirmation (artboard 1d, reduced to the count) */
function QueuePosition({ n, m }: { n: number; m: number }) {
  const { t, f } = useI18n()
  return (
    <div className="mb-6 flex w-full items-center gap-3">
      <div aria-hidden className="flex flex-1 gap-1">
        {Array.from({ length: m }, (_, i) => (
          <span key={i} className={cn('h-[3px] flex-1 rounded-full', i < n ? 'bg-primary' : 'bg-border')} />
        ))}
      </div>
      <span className="text-[13px] font-semibold text-muted-foreground tabular-nums">{f(t.confirmPerson.position, { n, m })}</span>
    </div>
  )
}

export function PersonConfirmActions({ busy, onConfirm, onNotNow }: { busy?: boolean; onConfirm: () => void; onNotNow: () => void }) {
  const { t } = useI18n()
  return (
    <>
      <PrimaryAction label={t.confirmPerson.confirm} busy={busy === true} onClick={onConfirm} />
      <Button size="lg" variant="muted" className="w-full" disabled={busy === true} onClick={onNotNow}>
        {t.confirmPerson.notNow}
      </Button>
    </>
  )
}

/** The success moment (handshake UX 2.7, E7; look: artboard 2b): both avatars side by side with a
 *  double arrow and one sentence. The flow's `success` and the shell's sheet; the caller adds the
 *  confetti and the actions. */
export function MutualMoment({ me, name, Title = 'h2' }: { me: string; name: string; Title?: ElementType }) {
  const { t, f } = useI18n()
  return (
    <div role="status" className="flex flex-1 flex-col items-center justify-center pb-10 text-center">
      <div aria-hidden className="flex items-center gap-3.5">
        <PersonAvatar name={me} size={96} />
        <svg width="44" height="24" viewBox="0 0 44 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className="flex-none text-primary">
          <path d="M4 12h36M10 5 3 12l7 7M34 5l7 7-7 7" />
        </svg>
        <PersonAvatar name={name} size={96} />
      </div>
      <Title className="m-0 mt-8 max-w-[16ch] text-2xl leading-tight font-bold tracking-[-0.01em] text-balance">{f(t.verify.successBody, { name: firstName(name) })}</Title>
    </div>
  )
}

export const firstName = (name: string): string => name.trim().split(/\s+/)[0] || name
