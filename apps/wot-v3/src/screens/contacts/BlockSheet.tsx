// Silent block and unblock (paper §7.1, §7.6), from the contact detail: one question, one act.
import { useEffect, useRef, useState, type RefObject } from 'react'
import type { ContactId } from '../../port'
import { useBlock } from '../../hooks'
import { useI18n } from '../../i18n'
import { DialogDescription, DialogTitle, Sheet, SheetContent } from '../../ui/primitives'
import { Callout, PrimaryAction, QuietAction } from '../../ui/components'

export function BlockSheet({
  contactId,
  name,
  mode,
  open,
  onClose,
  fallbackFocus,
}: {
  contactId: ContactId
  name: string
  mode: 'block' | 'unblock'
  open: boolean
  onClose: () => void
  fallbackFocus: RefObject<HTMLElement | null>
}) {
  const { t, f } = useI18n()
  const b = t.block
  const act = useBlock(contactId)
  const [failed, setFailed] = useState(false)
  const opener = useRef<HTMLElement | null>(null)
  useEffect(() => {
    if (open && typeof document !== 'undefined') opener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
  }, [open])
  const confirm = async () => {
    const r = await (mode === 'block' ? act.block() : act.unblock())
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
        <DialogTitle className="m-0 text-lg leading-snug font-bold text-balance">{f(mode === 'block' ? b.title : b.unblockTitle, { name })}</DialogTitle>
        <DialogDescription className="m-0 text-sm text-pretty text-muted-foreground">{f(mode === 'block' ? b.body : b.unblockBody, { name })}</DialogDescription>
        {failed ? (
          <Callout tone="danger" role="alert">
            {b.failed}
          </Callout>
        ) : null}
        <div className="flex flex-col gap-2">
          <PrimaryAction label={mode === 'block' ? b.confirm : b.unblockConfirm} variant={mode === 'block' ? 'destructive' : 'default'} busy={act.busy} onClick={() => void confirm()} />
          <QuietAction label={t.common.cancel} onClick={onClose} />
        </div>
      </SheetContent>
    </Sheet>
  )
}
