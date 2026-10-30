// Pieces of the verify and contact screens (design prototype: verify page, contact detail).
import type { ElementType, ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { useI18n } from '../../i18n'
import { Button, cn } from '../primitives'
import { Callout, PrimaryAction } from './identity'
import { PersonAvatar } from './PersonAvatar'
import { ClockIcon, ScanIcon } from './icons'

/** The camera with its frame and scan line (scan line off under reduced motion), on the page's own
 *  ground on every width: no dark area around it (Anton 29.10.: the dark square looks strange). The
 *  frame has the width of the shown code where it fits.
 *  `viewportRef`: the element a web camera renders into (ScannerPort.scan target); native scanners
 *  are full screen and leave it empty. html5-qrcode sets `position: relative` on that element, so it
 *  fills a positioned wrapper by size, not by inset (otherwise it has no height and the video stops
 *  short of the frame). */
export function ScannerFrame({ lead, hint, children, viewportRef }: { lead: string; hint: string; children?: ReactNode; viewportRef?: (el: HTMLDivElement | null) => void }) {
  return (
    <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-4">
      <div className="text-base font-medium">{lead}</div>
      <div aria-hidden className="relative aspect-square w-full max-w-[326px] overflow-hidden rounded-xl border-2 border-primary bg-[oklch(20%_0.01_265)]">
        <div className="absolute inset-0">
          <div ref={viewportRef} data-scan-viewport="" className="h-full w-full [&_video]:!h-full [&_video]:!w-full [&_video]:object-cover" />
        </div>
        <span className="absolute inset-x-[8%] top-1/2 h-0.5 bg-[oklch(72%_0.16_264)] shadow-[0_0_12px_oklch(72%_0.16_264)] motion-safe:animate-[scanline_2.4s_ease-in-out_infinite]" />
      </div>
      <div className="max-w-[34ch] text-center text-sm text-pretty text-muted-foreground">{hint}</div>
      {children}
    </div>
  )
}

/** A titled card section of the contact detail (prototype: uppercase label above a card); `icon` sits
 *  at the left of the card as in the action rows (Anton 29.10.). */
export function DetailSection({ title, icon, children }: { title: string; icon?: ReactNode; children: ReactNode }) {
  return (
    <section className="flex flex-none flex-col gap-2">
      <h2 className="m-0 px-1 text-[11px] font-semibold tracking-[.08em] text-muted-foreground uppercase">{title}</h2>
      <div className="flex gap-3.5 rounded-xl border border-border bg-card px-4 py-3.5">
        {icon ? <span className="mt-0.5 flex-none text-muted-foreground [&_svg]:size-[18px] [&_svg]:stroke-[1.75]">{icon}</span> : null}
        <div className="flex min-w-0 flex-1 flex-col gap-2.5">{children}</div>
      </div>
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

/** Confetti for a new mutual connection, as in the old Web of Trust app (Anton 29.10.: "das Konfetti
 *  sollte immer über die ganze App gehen und der alten WoT-App entsprechen"): fifty pieces in six
 *  colors, round and square, 4–12 px, falling from the top through the whole window and fading out.
 *  Portaled to the document so a sheet or a page never clips it; above every dialog, never taking a
 *  click; nothing under reduced motion (architecture §6.5). The old app drew the pieces at random;
 *  here they come from a fixed spread per index, so every screenshot is the same. */
const CONFETTI_COLORS = ['#10b981', '#3b82f6', '#f59e0b', '#ef4444', '#8b5cf6', '#ec4899']
const spread = (i: number, salt: number): number => {
  const x = Math.sin(i * 12.9898 + salt * 78.233) * 43758.5453
  return x - Math.floor(x)
}
export function Confetti() {
  if (typeof document === 'undefined') return null
  return createPortal(
    <div aria-hidden data-confetti className="pointer-events-none fixed inset-0 z-[100] overflow-hidden motion-reduce:hidden">
      {Array.from({ length: 50 }, (_, i) => {
        const size = 4 + spread(i, 3) * 8
        return (
          <span
            key={i}
            className="absolute"
            style={{
              left: `${spread(i, 1) * 100}%`,
              top: -12,
              width: size,
              height: size,
              borderRadius: i % 2 === 0 ? '50%' : 2,
              background: CONFETTI_COLORS[Math.floor(spread(i, 2) * CONFETTI_COLORS.length)],
              animation: `confetti-fall ${2 + spread(i, 4) * 2}s ease-in ${spread(i, 5) * 1.5}s forwards`,
            }}
          />
        )
      })}
    </div>,
    document.body,
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
      <Title className="m-0 mt-7 text-lg leading-snug font-semibold text-balance">{when === 'now' ? c.question : f(c.questionMet, { name: first })}</Title>
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
