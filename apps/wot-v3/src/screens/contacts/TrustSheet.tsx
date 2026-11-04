// The trust switch's question (handover desktop frames PR 3, Anton 29.10.: a hint on switching on and
// off): one sheet, one act. On: the anchor is disclosed, the profile and the groups follow (Trust
// 2770, 2760); what is disclosed stays known. Off: nothing new is shared; what the contact holds stays.
//
// On carries "Advanced settings" (Anton 04.11.): the anchor (that is the trust itself, no switch), the
// profile and the group identities, shown as stored. What the person changed there is written before
// the trust is given (off: it never goes out with it; on: back to following the trust); an untouched
// class keeps its stored policy (review 504).
import { useEffect, useRef, useState, type RefObject } from 'react'
import type { ContactId, TrustClass } from '../../port'
import { useContact, useTrust } from '../../hooks'
import { useI18n } from '../../i18n'
import { DialogDescription, DialogTitle, Sheet, SheetContent, Switch } from '../../ui/primitives'
import { Callout, ChevronRightIcon, PrimaryAction, QuietAction } from '../../ui/components'
import { TRUST_CLASSES } from './TrustSection'

export function TrustSheet({
  contactId,
  name,
  mode,
  open,
  onClose,
  onDone,
  fallbackFocus,
}: {
  contactId: ContactId
  name: string
  mode: 'on' | 'off'
  open: boolean
  onClose: () => void
  /** after the act committed (the success moment goes on to the chat) */
  onDone?: () => void
  fallbackFocus: RefObject<HTMLElement | null>
}) {
  const { t, f } = useI18n()
  const s = t.trustSheet
  const d = t.contactDetail
  const act = useTrust(contactId)
  const [failed, setFailed] = useState(false)
  const [advanced, setAdvanced] = useState(false)
  const contact = useContact(contactId)
  const classes = contact.status === 'ready' ? (contact.value?.classes ?? null) : null
  /** what the store says: a class is off when its setting is off */
  const storedOff = (cls: TrustClass) => classes?.[cls].setting === 'off'
  /** the person's choices in the advanced settings, over the stored state (review 504): only what
   *  they touched; untouched classes keep their stored policy */
  const [chosen, setChosen] = useState<Readonly<Partial<Record<TrustClass, boolean>>>>({})
  const isOn = (cls: TrustClass) => chosen[cls] ?? !storedOff(cls)
  const opener = useRef<HTMLElement | null>(null)
  useEffect(() => {
    if (open && typeof document !== 'undefined') opener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
  }, [open])
  const confirm = async () => {
    // compared with the store at each try: after a partial success the store holds what went through
    for (const [cls, on] of mode === 'on' ? (Object.entries(chosen) as [TrustClass, boolean][]) : []) {
      if (on === !storedOff(cls)) continue
      const c = await act.setClass(cls, on ? 'default' : 'off')
      if (!c.ok) return setFailed(true)
    }
    const r = await (mode === 'on' ? act.give() : act.withdraw())
    if (r.ok) {
      onClose()
      onDone?.()
    } else setFailed(true)
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
        {mode === 'on' ? (
          <div className="flex flex-col">
            <button
              type="button"
              aria-expanded={advanced}
              aria-controls={`${contactId}-advanced`}
              onClick={() => setAdvanced((v) => !v)}
              className="hit-target relative -mx-1 flex min-h-9 items-center gap-1 self-start rounded-md px-1 text-[13px] text-muted-foreground hover:text-foreground"
            >
              {d.classesToggle}
              <ChevronRightIcon className={advanced ? 'size-4 rotate-90 transition-transform' : 'size-4 transition-transform'} />
            </button>
            {advanced ? (
              <ul id={`${contactId}-advanced`} aria-label={d.classesToggle} className="m-0 flex list-none flex-col divide-y divide-border border-t border-border p-0">
                {TRUST_CLASSES.map((cls) => {
                  const label = d.classes[cls]
                  const id = `${contactId}-advanced-${cls}`
                  return (
                    <li key={cls} className="flex min-h-12 items-center justify-between gap-3 py-2">
                      <span className="flex min-w-0 flex-col">
                        <span id={id} className={cls === 'anchorMapping' ? 'text-sm font-semibold' : 'text-sm font-medium'}>
                          {label.name}
                        </span>
                        <span className="text-xs text-pretty text-muted-foreground">{f(label.body, { name })}</span>
                      </span>
                      {/* the anchor is the trust itself: it goes out with "Trust", no switch */}
                      {cls === 'anchorMapping' ? null : (
                        <Switch aria-labelledby={id} checked={isOn(cls)} disabled={act.busy} onCheckedChange={(on) => setChosen((c) => ({ ...c, [cls]: on }))} />
                      )}
                    </li>
                  )
                })}
              </ul>
            ) : null}
          </div>
        ) : null}
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
