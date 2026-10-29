// The confirmation of a person as a sheet (handshake UX 2.5, E4): from the decision card in the
// conversation or "Verify back now" in the contact detail (`when: 'met'`, E6), and the incoming
// confirmations while the answered card is still valid (`when: 'now'`, the shell's queue, 2.6).
// Confirming accepts the open encounter-confirm (architecture §2.7 counterVerify); "not now" leaves it
// open. The same body and actions as the flow's confirmation; the look is PR B's.
import { useEffect, useRef, useState, type RefObject } from 'react'
import type { ContactId } from '../../port'
import { useCounterVerify } from '../../hooks'
import { DialogDescription, DialogTitle, Sheet, SheetContent } from '../../ui/primitives'
import { PersonConfirmActions, PersonConfirmBody } from '../../ui/components'

/** a confirmation the caller runs (the shell's queue runs it through its machine) */
export interface ConfirmRun {
  readonly busy: boolean
  readonly failed: boolean
  confirm(): void
}

export function CounterSheet({
  contactId,
  name,
  open,
  onClose,
  fallbackFocus,
  when = 'met',
  position = null,
  run,
}: {
  contactId: ContactId
  name: string
  open: boolean
  /** "not now", ×, Escape: the decision stays open */
  onClose: () => void
  /** where focus goes when the element that opened the sheet is gone (§6.5) */
  fallbackFocus?: RefObject<HTMLElement | null>
  when?: 'now' | 'met'
  position?: { readonly n: number; readonly m: number } | null
  run?: ConfirmRun
}) {
  const counter = useCounterVerify()
  const [failed, setFailed] = useState(false)
  // the opener is not a Radix trigger: remember it and give focus back on close (§6.5, review 420 R1-12)
  const opener = useRef<HTMLElement | null>(null)
  const content = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    if (open && typeof document !== 'undefined') opener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
  }, [open])
  const own = async () => {
    setFailed(false)
    const r = await counter.run(contactId)
    if (r.ok) onClose()
    else setFailed(true)
  }
  const busy = run ? run.busy : counter.busy
  return (
    <Sheet open={open} onOpenChange={(o) => (!o && !busy ? onClose() : undefined)}>
      <SheetContent
        ref={content}
        className="flex flex-col gap-4"
        // it can come unasked (the shell's queue): the first focus is the sheet, never "Confirm", so
        // an Enter meant for something else confirms no one (handshake UX 2.5)
        onOpenAutoFocus={(e) => {
          e.preventDefault()
          content.current?.focus()
        }}
        onCloseAutoFocus={(e) => {
          e.preventDefault()
          const target = opener.current?.isConnected ? opener.current : fallbackFocus?.current
          target?.focus()
        }}
      >
        <PersonConfirmBody name={name} when={when} position={position} failed={run ? run.failed : failed} Title={DialogTitle} Description={DialogDescription} />
        <div className="flex flex-col gap-2">
          <PersonConfirmActions busy={busy} onConfirm={() => (run ? run.confirm() : void own())} onNotNow={onClose} />
        </div>
      </SheetContent>
    </Sheet>
  )
}
