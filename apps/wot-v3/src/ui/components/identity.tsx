// Building blocks of the identity screens (architecture §6.2 "Identität"): page frame, hero,
// step progress, callouts, word grid, checklist, passphrase and word fields, choice cards, progress.
// Look from the design prototype (verify and found-group pages: 36 px header button, 15 px title,
// a centered column up to 520 px, 44 px primary buttons, callout with a left accent bar); structure
// and quality details from the legacy identity flows (DA §3). Labels come in as props or from i18n.
import { useId, useState, type ReactNode } from 'react'
import { useI18n } from '../../i18n'
import { Button, cn } from '../primitives'
import { AlertIcon, CheckIcon, ChevronLeftIcon, CloseIcon, EyeIcon, EyeOffIcon } from './icons'
import { MainLandmark } from './landmark'
import { PAGE_TITLE_ATTR, usePageFrame } from './Page'

/** A flow's page: header with back or close, a centered scrolling column, footer actions. On the
 *  phone the full screen; on the desktop laid out for its page frame (ui/components/Page.tsx): in the
 *  app a bar with “‹ area”, the title and ×; standalone (no navigation) under the app's header; the
 *  column in both the one narrow content width (max-w-narrow, as the dialog); standalone, the title
 *  is for screen readers (the hero carries it). The children keep their place in the tree in both
 *  layouts: nothing remounts across the breakpoint. */
export function FlowPage({
  title,
  onBack,
  backKind = 'back',
  children,
  footer,
  progress,
  titleHidden = false,
}: {
  title: string
  /** the page's own heading carries the moment (handshake UX artboard 2b): the title stays for
   *  screen readers only */
  titleHidden?: boolean
  onBack?: (() => void) | undefined
  backKind?: 'back' | 'close'
  children: ReactNode
  footer?: ReactNode
  progress?: ReactNode
}) {
  const { t } = useI18n()
  const headingId = useId()
  const frame = usePageFrame()
  const desk = frame?.wide === true ? frame.variant : null
  const close = backKind === 'close'
  const heading = (className: string) => (
    <h1 id={headingId} {...{ [PAGE_TITLE_ATTR]: '' }} tabIndex={desk ? -1 : undefined} className={cn(className, desk && 'outline-none')}>
      {title}
    </h1>
  )
  const backLabel = close ? (frame?.area ?? t.common.back) : t.common.back
  const textBack = onBack ? (
    <button
      type="button"
      onClick={onBack}
      className="hit-target relative flex h-9 flex-none items-center gap-1.5 rounded-md pr-2 text-sm font-medium text-primary-strong hover:underline"
    >
      <ChevronLeftIcon className="size-4" />
      {backLabel}
    </button>
  ) : null
  const closeButton =
    onBack && close ? (
      <button
        type="button"
        onClick={onBack}
        aria-label={t.common.close}
        className="hit-target relative ml-auto flex size-11 flex-none items-center justify-center rounded-md text-foreground hover:bg-muted md:size-9"
      >
        <CloseIcon className="size-5" />
      </button>
    ) : null
  // on its own the page is the main landmark; inside the shell's main, a named region
  return (
    <MainLandmark nested="section" labelledBy={headingId} className="flex min-h-0 flex-1 flex-col bg-background text-foreground">
      {desk === 'app' ? (
        <header className="flex flex-none justify-center px-8 pt-6">
          <div className="flex min-h-11 w-full max-w-[720px] items-center gap-3">
            {/* the area link closes the flow (canvas: “‹ Contacts” and ×); a step back of the flow says “Back” */}
            {textBack}
            {heading(titleHidden ? 'sr-only' : 'm-0 min-w-0 flex-1 truncate text-center text-[15px] font-semibold')}
            {titleHidden ? <span className="flex-1" /> : null}
            {closeButton ?? <span className="size-9 flex-none" />}
          </div>
        </header>
      ) : desk === 'standalone' ? null : (
        <header className="flex flex-none items-center gap-2 px-3 pt-3 pb-2">
          {onBack ? (
            <button
              type="button"
              onClick={onBack}
              aria-label={close ? t.common.close : t.common.back}
              className="hit-target relative flex size-11 flex-none items-center justify-center rounded-md text-foreground hover:bg-muted md:size-9"
            >
              {close ? <CloseIcon className="size-5" /> : <ChevronLeftIcon className="size-5" />}
            </button>
          ) : (
            <span className="size-2 flex-none" />
          )}
          {heading(titleHidden ? 'sr-only' : 'm-0 truncate text-[15px] font-semibold')}
        </header>
      )}
      {progress && !desk ? <div className="mx-auto w-full max-w-[520px] flex-none px-5">{progress}</div> : null}
      <div className={cn('flex min-h-0 flex-1 flex-col overflow-auto', desk && 'px-8')}>
        <div
          className={cn(
            'mx-auto flex w-full flex-col gap-[18px] px-5',
            desk ? 'my-auto max-w-narrow py-8' : 'max-w-[520px] flex-1 pt-3 pb-6',
          )}
        >
          {desk === 'standalone' ? (
            <>
              {onBack ? (
                <div className="flex min-h-11 items-center">
                  {close ? null : textBack}
                  {closeButton}
                </div>
              ) : null}
              {heading('sr-only')}
              {progress}
            </>
          ) : desk === 'app' ? (
            progress
          ) : null}
          {children}
          {desk && footer ? <div className="flex flex-col gap-2 pt-2">{footer}</div> : null}
        </div>
      </div>
      {footer && !desk ? (
        <div className="flex-none border-t border-border bg-background">
          <div className="mx-auto flex w-full max-w-[520px] flex-col gap-2 px-5 pt-2.5 pb-[calc(0.75rem+var(--safe-bottom))]">{footer}</div>
        </div>
      ) : null}
    </MainLandmark>
  )
}

type Tone = 'primary' | 'success' | 'warning' | 'danger' | 'muted'

const TONE_CIRCLE: Record<Tone, string> = {
  primary: 'bg-[color-mix(in_oklab,var(--primary)_10%,transparent)] text-primary-strong',
  success: 'bg-[color-mix(in_oklab,var(--success)_12%,transparent)] text-success-strong',
  warning: 'bg-[color-mix(in_oklab,var(--warning)_15%,transparent)] text-warning-strong',
  danger: 'bg-[color-mix(in_oklab,var(--destructive)_12%,transparent)] text-destructive',
  muted: 'bg-muted text-muted-foreground',
}

/** Icon circle, title and lead of a step (prototype: success and confirm screens). The page title
 *  in the header is the h1, the hero title an h2 below it. */
export function Hero({ icon, tone = 'primary', title, body }: { icon: ReactNode; tone?: Tone; title: string; body?: ReactNode }) {
  return (
    <div className="flex flex-none flex-col items-center gap-3 pt-2 text-center">
      <span className={cn('flex size-16 items-center justify-center rounded-full [&_svg]:size-[30px]', TONE_CIRCLE[tone])}>{icon}</span>
      <h2 className="m-0 text-[22px] leading-tight font-bold tracking-[-0.02em] text-balance">{title}</h2>
      {body ? <div className="m-0 max-w-[40ch] text-sm text-pretty text-muted-foreground">{body}</div> : null}
    </div>
  )
}

/** "Step n of m" with a segmented bar (legacy ProgressIndicator, reduced). */
export function StepProgress({ current, total, labels }: { current: number; total: number; labels: readonly string[] }) {
  const { t, f } = useI18n()
  const label = f(t.common.stepOf, { current, total })
  return (
    <div className="flex flex-col gap-1.5 pt-1" role="group" aria-label={label}>
      <div className="flex gap-1" aria-hidden>
        {Array.from({ length: total }, (_, i) => (
          <span key={i} className={cn('h-1 flex-1 rounded-full', i < current ? 'bg-primary' : 'bg-border')} />
        ))}
      </div>
      <div className="flex justify-between text-xs text-muted-foreground">
        <span>{label}</span>
        <span>{labels[current - 1] ?? ''}</span>
      </div>
    </div>
  )
}

const CALLOUT: Record<'info' | 'warning' | 'danger' | 'success', string> = {
  info: 'border-l-primary bg-[color-mix(in_oklab,var(--primary)_6%,var(--card))]',
  warning: 'border-l-warning bg-[color-mix(in_oklab,var(--warning)_8%,var(--card))]',
  danger: 'border-l-destructive bg-[color-mix(in_oklab,var(--destructive)_7%,var(--card))]',
  success: 'border-l-success bg-[color-mix(in_oklab,var(--success)_8%,var(--card))]',
}

/** Note with a left accent bar (prototype: waiting note). Errors use role="alert". */
export function Callout({
  tone,
  children,
  role,
  id,
}: {
  tone: 'info' | 'warning' | 'danger' | 'success'
  children: ReactNode
  role?: 'alert' | 'status' | undefined
  id?: string | undefined
}) {
  return (
    <div
      id={id}
      role={role}
      className={cn('flex flex-none gap-2.5 rounded-r-lg border-l-[3px] px-3.5 py-3 text-[13px] leading-relaxed text-pretty', CALLOUT[tone])}
    >
      {tone === 'warning' || tone === 'danger' ? (
        <AlertIcon className={cn('mt-0.5 size-4 flex-none', tone === 'danger' ? 'text-destructive' : 'text-warning-strong')} />
      ) : null}
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  )
}

/** Numbered list of the words, in reading order row by row (legacy display step). */
export function MnemonicGrid({ words, label }: { words: readonly string[]; label: string }) {
  return (
    <ol
      aria-label={label}
      className="m-0 grid flex-none list-none grid-cols-2 gap-x-4 gap-y-2.5 rounded-xl border border-border bg-card p-4 min-[380px]:grid-cols-3"
    >
      {words.map((w, i) => (
        <li key={i} className="flex items-baseline gap-2">
          <span className="w-6 flex-none text-right text-xs text-muted-foreground tabular-nums">{i + 1}.</span>
          <span className="font-mono text-[15px] font-medium">{w}</span>
        </li>
      ))}
    </ol>
  )
}

/** Three checks before the words go away (legacy SecurityChecklist). */
export function Checklist({ title, items, onToggle }: { title: string; items: readonly { label: string; checked: boolean }[]; onToggle: (i: number) => void }) {
  return (
    <fieldset className="m-0 flex flex-none flex-col gap-0 rounded-lg border border-border bg-card p-0">
      <legend className="sr-only">{title}</legend>
      <div aria-hidden className="px-4 pt-3 pb-1 text-[11px] font-semibold tracking-[0.08em] text-muted-foreground uppercase">
        {title}
      </div>
      {items.map((item, i) => (
        <CheckRow key={i} label={item.label} checked={item.checked} onChange={() => onToggle(i)} />
      ))}
    </fieldset>
  )
}

/** One checkbox row, 44 px tall; the whole row is the label and so the hit area. */
export function CheckRow({ label, checked, onChange, hint }: { label: string; checked: boolean; onChange: (v: boolean) => void; hint?: ReactNode }) {
  return (
    <label className="flex min-h-11 cursor-pointer items-start gap-3 px-4 py-2.5">
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className="mt-0.5 size-5 flex-none cursor-pointer rounded accent-[var(--primary)]"
      />
      <span className="flex-1 text-sm leading-snug">
        {label}
        {hint ? <span className="mt-0.5 block text-xs text-muted-foreground">{hint}</span> : null}
      </span>
    </label>
  )
}

const FIELD =
  'h-11 w-full min-w-0 rounded-lg border border-border bg-card px-4 text-[15px] text-foreground outline-none transition-[box-shadow,border-color] placeholder:text-muted-foreground focus-visible:border-transparent focus-visible:ring-2 focus-visible:ring-ring aria-invalid:border-destructive'

/** Label, input and error/hint line, wired with aria-describedby (architecture §6.5). */
export function Field({
  label,
  error,
  hint,
  children,
}: {
  label: string
  error?: string | null | undefined
  hint?: ReactNode
  children: (props: { id: string; 'aria-describedby'?: string; 'aria-invalid'?: boolean }) => ReactNode
}) {
  const id = useId()
  const describedBy = error || hint ? `${id}-d` : undefined
  return (
    <div className="flex flex-none flex-col gap-1.5">
      <label htmlFor={id} className="text-sm font-medium">
        {label}
      </label>
      {children({ id, ...(describedBy ? { 'aria-describedby': describedBy } : {}), ...(error ? { 'aria-invalid': true } : {}) })}
      {error ? (
        <p id={describedBy} role="alert" className="m-0 text-[13px] text-destructive">
          {error}
        </p>
      ) : hint ? (
        <p id={describedBy} className="m-0 text-xs text-muted-foreground">
          {hint}
        </p>
      ) : null}
    </div>
  )
}

/** Text field for words: no autocomplete, no spell check, no auto capitals (architecture §5). */
export function WordInput(props: {
  inputRef?: (el: HTMLInputElement | null) => void
  label: string
  value: string
  onChange: (v: string) => void
  onEnter?: () => void
  placeholder?: string
  error?: string | null
  autoFocus?: boolean
}) {
  return (
    <Field label={props.label} error={props.error}>
      {(a) => (
        <input
          {...a}
          ref={props.inputRef}
          type="text"
          value={props.value}
          placeholder={props.placeholder}
          autoFocus={props.autoFocus}
          autoComplete="off"
          autoCorrect="off"
          autoCapitalize="off"
          spellCheck={false}
          onChange={(e) => props.onChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              props.onEnter?.()
            }
          }}
          className={cn(FIELD, 'font-mono')}
        />
      )}
    </Field>
  )
}

/** Passphrase field with an eye toggle: a toggle button in the tab order after the field, fixed
 *  label, state in aria-pressed (architecture §6.5). */
export function PassphraseInput(props: {
  label: string
  value: string
  onChange: (v: string) => void
  onEnter?: () => void
  placeholder?: string
  autoComplete: 'new-password' | 'current-password'
  error?: string | null
  hint?: ReactNode
  autoFocus?: boolean
  shown?: boolean
  onToggleShown?: () => void
}) {
  const { t } = useI18n()
  const [localShown, setLocalShown] = useState(false)
  const shown = props.shown ?? localShown
  const toggle = props.onToggleShown ?? (() => setLocalShown((v) => !v))
  return (
    <Field label={props.label} error={props.error} hint={props.hint}>
      {(a) => (
        <div className="relative">
          <input
            {...a}
            type={shown ? 'text' : 'password'}
            value={props.value}
            placeholder={props.placeholder}
            autoFocus={props.autoFocus}
            autoComplete={props.autoComplete}
            autoCapitalize="off"
            spellCheck={false}
            onChange={(e) => props.onChange(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault()
                props.onEnter?.()
              }
            }}
            className={cn(FIELD, 'pr-12')}
          />
          <button
            type="button"
            onClick={toggle}
            aria-label={t.common.showPassphrase}
            aria-pressed={shown}
            className="hit-target absolute top-1/2 right-1 flex size-10 -translate-y-1/2 items-center justify-center rounded-md text-muted-foreground hover:text-foreground"
          >
            {shown ? <EyeOffIcon className="size-5" /> : <EyeIcon className="size-5" />}
          </button>
        </div>
      )}
    </Field>
  )
}

/** A choice as a card button (protect step: biometrics or passphrase). */
export function ChoiceCard({
  icon,
  title,
  sub,
  onClick,
  disabled,
}: {
  icon: ReactNode
  title: string
  sub: string
  onClick: () => void
  disabled?: boolean
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="flex w-full flex-none items-center gap-3 rounded-lg border border-border bg-card px-4 py-3.5 text-left text-inherit transition-colors hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50"
    >
      <span className="flex size-10 flex-none items-center justify-center rounded-full bg-[color-mix(in_oklab,var(--primary)_10%,transparent)] text-primary [&_svg]:size-5">
        {icon}
      </span>
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="text-[15px] font-semibold">{title}</span>
        <span className="text-[13px] text-pretty text-muted-foreground">{sub}</span>
      </span>
    </button>
  )
}

/** A step that runs on its own: spinner and a live label (role="status"). */
export function Working({ label }: { label: string }) {
  return (
    <div role="status" aria-live="polite" className="flex flex-1 flex-col items-center justify-center gap-4 py-10 text-center">
      <span aria-hidden className="size-8 animate-spin rounded-full border-2 border-primary-100 border-t-primary" />
      <span className="text-sm text-muted-foreground">{label}</span>
    </div>
  )
}

/** Phases of a longer job (delete, restore): done, current, pending. */
export function PhaseList({ phases, current }: { phases: readonly { id: string; label: string }[]; current: string }) {
  const at = phases.findIndex((p) => p.id === current)
  return (
    <ol className="m-0 flex flex-none list-none flex-col gap-0 rounded-lg border border-border bg-card p-0" aria-live="polite">
      {phases.map((p, i) => (
        <li key={p.id} aria-current={i === at ? 'step' : undefined} className="flex items-center gap-3 border-t border-border px-4 py-2.5 text-sm first:border-t-0">
          <span
            aria-hidden
            className={cn(
              'flex size-5 flex-none items-center justify-center rounded-full',
              i < at ? 'bg-success text-success-foreground' : i === at ? 'border-2 border-primary border-t-transparent animate-spin' : 'border border-border',
            )}
          >
            {i < at ? <CheckIcon className="size-3" /> : null}
          </span>
          <span className={cn(i > at && 'text-muted-foreground', i === at && 'font-medium')}>{p.label}</span>
        </li>
      ))}
    </ol>
  )
}

/** What survived a wipe (legacy: the error stays visible with the confirmation, 14dc3649). */
export function SurvivorList({ title, items }: { title: string; items: readonly string[] }) {
  return (
    <div className="flex flex-none flex-col gap-1 rounded-lg bg-muted px-3.5 py-2.5 text-[13px]">
      <span className="font-medium">{title}</span>
      <ul className="m-0 list-none p-0 font-mono text-xs text-muted-foreground">
        {items.map((s) => (
          <li key={s} className="break-all">
            {s}
          </li>
        ))}
      </ul>
    </div>
  )
}

/** Primary (44 px) and quiet (36 px) actions of a step. */
export function PrimaryAction(props: { label: string; onClick: () => void; disabled?: boolean; variant?: 'default' | 'destructive'; busy?: boolean }) {
  return (
    <Button size="lg" variant={props.variant ?? 'default'} className="w-full" onClick={props.onClick} disabled={props.disabled === true || props.busy === true} aria-busy={props.busy}>
      {props.label}
    </Button>
  )
}

export function QuietAction({ label, onClick, disabled }: { label: string; onClick: () => void; disabled?: boolean }) {
  return (
    <Button variant="ghost" className="h-11 w-full text-sm md:h-9" onClick={onClick} disabled={disabled}>
      {label}
    </Button>
  )
}

export function OutlineAction({ label, onClick, icon, disabled }: { label: string; onClick: () => void; icon?: ReactNode; disabled?: boolean }) {
  return (
    <Button variant="outline" size="lg" className="w-full [&_svg]:size-[18px]" onClick={onClick} disabled={disabled}>
      {icon}
      {label}
    </Button>
  )
}
