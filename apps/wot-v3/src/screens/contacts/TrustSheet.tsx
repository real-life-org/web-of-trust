// The trust switch's question (handover desktop frames PR 3, Anton 29.10.: a hint on switching on and
// off): one sheet, one act. On: the anchor is disclosed, the profile and the groups follow (Trust
// 2770, 2760); what is disclosed stays known. Off: nothing new is shared; what the contact holds stays.
import { useEffect, useRef, useState, type RefObject } from 'react'
import type { ContactId } from '../../port'
import { useTrust } from '../../hooks'
import { useI18n } from '../../i18n'
import { DialogDescription, DialogTitle, Sheet, SheetContent } from '../../ui/primitives'
import { Callout, PrimaryAction, QuietAction } from '../../ui/components'

export function TrustSheet({
  contactId,
  name,
  mode,
  open,
  onClose,
  fallbackFocus,
}: {
  contactId: ContactId
  name: string
  mode: 'on' | 'off'
  open: boolean
  onClose: () => void
  fallbackFocus: RefObject<HTMLElement | null>
}) {
  const { t, f } = useI18n()
  const s = t.trustSheet
  const act = useTrust(contactId)
  const [failed, setFailed] = useState(false)
  const opener = useRef<HTMLElement | null>(null)
  useEffect(() => {
    if (open && typeof document !== 'undefined') opener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
  }, [open])
  const confirm = async () => {
    const r = await (mode === 'on' ? act.give() : act.withdraw())
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
        <DialogTitle className="m-0 text-lg leading-snug font-bold text-balance">{f(mode === 'on' ? s.onTitle : s.offTitle, { name })}</DialogTitle>
        <DialogDescription className="m-0 text-sm text-pretty text-muted-foreground">{f(mode === 'on' ? s.onBody : s.offBody, { name })}</DialogDescription>
        {failed ? (
          <Callout tone="danger" role="alert">
            {s.failed}
          </Callout>
        ) : null}
        <div className="flex flex-col gap-2">
          <PrimaryAction label={mode === 'on' ? s.onConfirm : s.offConfirm} busy={act.busy} onClick={() => void confirm()} />
          <QuietAction label={t.common.cancel} onClick={onClose} />
        </div>
      </SheetContent>
    </Sheet>
  )
}
