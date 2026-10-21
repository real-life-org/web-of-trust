// The counter-step as a question (design sheet "counter"): from the decision card in the
// conversation or "Verify back now" in the contact detail. Confirming accepts the open
// encounter-confirm (architecture §2.7 counterVerify); "not now" leaves it incoming.
import { useEffect, useRef, useState, type RefObject } from 'react'
import type { ContactId } from '../../port'
import { useCounterVerify } from '../../hooks'
import { useI18n } from '../../i18n'
import { DialogDescription, DialogTitle, Sheet, SheetContent } from '../../ui/primitives'
import { Callout, FactRow, PersonAvatar, PrimaryAction, QuietAction } from '../../ui/components'

export function CounterSheet({
  contactId,
  name,
  open,
  onClose,
  fallbackFocus,
}: {
  contactId: ContactId
  name: string
  open: boolean
  onClose: () => void
  /** where focus goes when the element that opened the sheet is gone (§6.5) */
  fallbackFocus: RefObject<HTMLElement | null>
}) {
  const { t, f } = useI18n()
  const c = t.counter
  const counter = useCounterVerify()
  const [failed, setFailed] = useState(false)
  // the opener is not a Radix trigger: remember it and give focus back on close (§6.5, review 420 R1-12)
  const opener = useRef<HTMLElement | null>(null)
  useEffect(() => {
    if (open && typeof document !== 'undefined') opener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
  }, [open])
  const confirm = async () => {
    setFailed(false)
    const r = await counter.run(contactId)
    if (r.ok) onClose()
    else setFailed(true)
  }
  return (
    <Sheet open={open} onOpenChange={(o) => (!o ? onClose() : undefined)}>
      <SheetContent
        className="flex flex-col gap-4"
        onCloseAutoFocus={(e) => {
          e.preventDefault()
          const target = opener.current?.isConnected ? opener.current : fallbackFocus.current
          target?.focus()
        }}
      >
        <div className="flex items-center gap-3">
          <PersonAvatar name={name} size={44} />
          <div className="flex min-w-0 flex-col">
            <span className="text-[11px] font-semibold tracking-[.06em] text-primary uppercase">{c.kind}</span>
            <DialogTitle className="m-0 text-lg leading-snug font-bold text-balance">{f(c.title, { name })}</DialogTitle>
          </div>
        </div>
        <DialogDescription className="m-0 text-sm text-pretty text-muted-foreground">{f(c.body, { name })}</DialogDescription>
        <div className="flex flex-col gap-2 rounded-lg border border-border bg-background px-3.5 py-3">
          <FactRow glyph="←" tone="primary" text={c.factIn} />
          <FactRow glyph="⇄" text={c.factMutual} />
        </div>
        {failed ? (
          <Callout tone="danger" role="alert">
            {c.failed}
          </Callout>
        ) : null}
        <div className="flex flex-col gap-2">
          <PrimaryAction label={c.confirm} busy={counter.busy} onClick={() => void confirm()} />
          <QuietAction label={c.notNow} onClick={onClose} />
        </div>
      </SheetContent>
    </Sheet>
  )
}
