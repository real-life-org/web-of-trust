import { useId } from 'react'
import { useI18n } from '../../i18n'
import { cn } from '../primitives'
import { SendIcon } from './icons'

export interface ComposerProps {
  placeholder: string
  /** hint above the field (design: "device has not been online since you met") */
  note?: string | null
  /** null: writing is possible; otherwise why not (screen reader text) */
  lockedReason: string | null
  value?: string
  onChange?: (v: string) => void
  onSend?: () => void
  /** the draft cannot go out as it is (too long) */
  sendDisabled?: boolean
  /** an action beside the note (an unsent text back into the field) */
  noteAction?: { label: string; onClick: () => void } | null
}

export function Composer({ placeholder, note, lockedReason, value = '', onChange, onSend, sendDisabled = false, noteAction }: ComposerProps) {
  const { t } = useI18n()
  const hintId = useId()
  const noteId = useId()
  const locked = lockedReason !== null
  const canSend = !locked && !sendDisabled && value.trim().length > 0
  return (
    <div className="flex-none border-t border-border bg-card px-3 pt-2 pb-[calc(10px+var(--safe-bottom))]">
      <div className="mx-auto flex max-w-[720px] flex-col gap-1.5">
        {note ? (
          <div id={noteId} aria-live="polite" className="text-center text-[11px] text-pretty text-muted-foreground">
            {note}
            {noteAction ? (
              <>
                {' '}
                <button type="button" onClick={noteAction.onClick} className="hit-target relative font-medium text-primary underline underline-offset-2">
                  {noteAction.label}
                </button>
              </>
            ) : null}
          </div>
        ) : null}
        <div className="flex items-center gap-2">
          <input
            value={value}
            onChange={(e) => onChange?.(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey && canSend) {
                e.preventDefault()
                onSend?.()
              }
            }}
            disabled={locked}
            placeholder={placeholder}
            aria-label={placeholder}
            aria-describedby={locked ? hintId : note ? noteId : undefined}
            className="h-[42px] min-w-0 flex-1 rounded-full border border-border bg-background px-4 text-sm text-foreground outline-none placeholder:text-muted-foreground focus-visible:border-transparent focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed"
          />
          <button
            type="button"
            onClick={onSend}
            disabled={!canSend}
            aria-label={t.chat.send}
            className={cn(
              'hit-target relative flex size-[42px] flex-none items-center justify-center rounded-full bg-primary text-primary-foreground',
              !canSend && 'cursor-not-allowed opacity-45',
            )}
          >
            <SendIcon className="size-[18px]" />
          </button>
        </div>
        {locked ? (
          <span id={hintId} className="sr-only">
            {lockedReason}
          </span>
        ) : null}
      </div>
    </div>
  )
}
