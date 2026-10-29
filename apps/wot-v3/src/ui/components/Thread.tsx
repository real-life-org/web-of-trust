// The pieces of a conversation thread (design: thread items day, sys, msg, card).
import { useId, type ReactNode } from 'react'
import { cn } from '../primitives'
import { TONE_TEXT, type Tone } from './glyphs'

export function ThreadScroller({ children }: { children: ReactNode }) {
  return (
    <div className="min-h-0 flex-1 overflow-auto px-3.5 pt-3 pb-4">
      <div className="mx-auto flex max-w-[720px] flex-col gap-1">{children}</div>
    </div>
  )
}

export function DayDivider({ label }: { label: string }) {
  return (
    <div className="mt-3 mb-1.5 self-center rounded-full bg-muted px-2.5 py-0.5 text-[11px] font-medium text-muted-foreground">
      {label}
    </div>
  )
}

export function SystemLine({ glyph, tone, text }: { glyph: string; tone: Tone; text: string }) {
  return (
    <div className="my-1.5 flex max-w-[92%] items-baseline gap-1.5 self-center text-center text-xs text-pretty text-muted-foreground">
      <span aria-hidden className={cn('flex-none font-mono text-[13px]', TONE_TEXT[tone])}>
        {glyph}
      </span>
      <span>{text}</span>
    </div>
  )
}

export interface MessageBubbleProps {
  mine: boolean
  text: string
  /** first message of a run by the same author */
  runStart: boolean
  /** shown under the last message of a run */
  meta: string | null
  /** own messages: delivered draws the meta in primary */
  metaStrong?: boolean
  /** group conversations: author above the first bubble of a run */
  author?: { name: string; className?: string } | null
  /** the earlier message this one answers */
  quote?: { author: string; text: string } | null
  /** a failed or held own message: the meta in the warning tone */
  metaWarning?: boolean
  /** an action under the bubble (failed message: send again as a new message) */
  action?: { label: string; onClick: () => void } | null
}

export function MessageBubble({ mine, text, runStart, meta, metaStrong, author, quote, metaWarning, action }: MessageBubbleProps) {
  return (
    <div
      className={cn(
        'flex max-w-[80%] flex-col gap-0.5',
        mine ? 'items-end self-end' : 'items-start self-start',
        runStart && 'mt-2',
      )}
    >
      {author ? <span className={cn('px-1 text-xs font-semibold', author.className)}>{author.name}</span> : null}
      <div
        className={cn(
          'px-3 py-2 text-sm leading-[1.45] whitespace-pre-wrap [overflow-wrap:anywhere]',
          mine
            ? 'rounded-[16px_16px_4px_16px] bg-primary text-primary-foreground'
            : 'rounded-[16px_16px_16px_4px] border border-border bg-card text-card-foreground',
        )}
      >
        {quote ? (
          <span
            className={cn(
              'mb-1 block border-l-2 py-0.5 pl-2 text-xs [overflow-wrap:anywhere]',
              mine ? 'border-primary-foreground/60 text-primary-foreground' : 'border-primary/50 text-muted-foreground',
            )}
          >
            <span className="block font-semibold">{quote.author}</span>
            <span className="line-clamp-2">{quote.text}</span>
          </span>
        ) : null}
        {text}
      </div>
      {meta !== null ? (
        <span
          className={cn(
            'text-[11px]',
            mine ? 'pr-1' : 'pl-1',
            metaWarning ? 'text-warning-strong' : mine && metaStrong ? 'text-primary' : 'text-muted-foreground',
          )}
        >
          {meta}
        </span>
      ) : null}
      {action ? (
        <button type="button" onClick={action.onClick} className="min-h-11 rounded-md px-1 text-xs font-medium text-primary underline-offset-2 hover:underline md:min-h-0">
          {action.label}
        </button>
      ) : null}
    </div>
  )
}

export interface DecisionCardProps {
  glyph: string
  tone: Tone
  kind: string
  title: string
  sub: string
  cta: string
  /** set when no longer open; the card then shows this line instead of the action */
  resolved: string | null
  onAction?: () => void
  /** a quiet second action beside the main one, with one sentence under it that says what it does
   *  (handshake UX A2: "Decline", the other person is not told) */
  secondary?: { readonly label: string; readonly note: string; readonly onClick: () => void } | null
  /** an action of this card runs: both are held */
  busy?: boolean
  /** the last action did not go through */
  error?: string | null
}

export function DecisionCard({ glyph, tone, kind, title, sub, cta, resolved, onAction, secondary = null, busy = false, error = null }: DecisionCardProps) {
  const noteId = useId()
  return (
    <div className="my-2 flex justify-center self-stretch">
      <div
        className={cn(
          'flex w-full max-w-[360px] flex-col gap-1.5 rounded-lg border bg-card px-3.5 py-3 shadow-xs',
          resolved === null ? 'border-[color-mix(in_oklab,var(--warning)_45%,var(--border))]' : 'border-border',
        )}
      >
        <span className={cn('text-[11px] font-semibold tracking-[.06em] uppercase', TONE_TEXT[tone])}>
          <span aria-hidden>{glyph}</span> {kind}
        </span>
        <span className="text-sm font-semibold text-pretty">{title}</span>
        <span className="text-xs text-pretty text-muted-foreground">{sub}</span>
        {resolved === null ? (
          <>
            <div className="mt-1 flex flex-wrap items-center gap-2">
              <button
                type="button"
                onClick={onAction}
                disabled={busy}
                className="hit-target relative h-[34px] rounded-md border border-transparent bg-primary px-3.5 text-[13px] font-medium text-primary-foreground disabled:opacity-60"
              >
                {cta}
              </button>
              {secondary ? (
                <button
                  type="button"
                  onClick={secondary.onClick}
                  disabled={busy}
                  aria-describedby={noteId}
                  className="hit-target relative h-[34px] rounded-md px-3 text-[13px] font-medium text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-60"
                >
                  {secondary.label}
                </button>
              ) : null}
            </div>
            {secondary ? (
              <span id={noteId} className="text-xs text-pretty text-muted-foreground">
                {secondary.note}
              </span>
            ) : null}
            {error ? (
              <span role="alert" className="text-xs text-pretty text-destructive">
                {error}
              </span>
            ) : null}
          </>
        ) : (
          <span className="mt-0.5 border-t border-border pt-2 text-xs font-medium text-pretty text-muted-foreground">
            {resolved}
          </span>
        )}
      </div>
    </div>
  )
}
