// The success moment as a sheet (handshake UX 2.7, E7; look: artboard 2b): wherever the person is in
// the app, when the relationship becomes mutual. Both avatars, one sentence, confetti, "Open chat";
// closing is quiet (the flow's "next person" belongs to the flow).
import { useRef } from 'react'
import { useI18n } from '../../i18n'
import { useProfile } from '../../hooks'
import { DialogTitle, Sheet, SheetContent } from '../../ui/primitives'
import { Confetti, MutualMoment, PrimaryAction, QuietAction } from '../../ui/components'

export function MutualSheet({ name, onOpenChat, onClose }: { name: string; onOpenChat: () => void; onClose: () => void }) {
  const { t } = useI18n()
  const profile = useProfile()
  const content = useRef<HTMLDivElement | null>(null)
  const me = profile.status === 'ready' ? (profile.value.name ?? t.contacts.unnamed) : t.contacts.unnamed
  return (
    <Sheet open onOpenChange={(o) => (!o ? onClose() : undefined)}>
      <SheetContent
        ref={content}
        className="flex flex-col gap-4 overflow-hidden"
        aria-describedby={undefined}
        // it comes unasked: the first focus is the sheet, not "Open chat" (handshake UX 2.5)
        onOpenAutoFocus={(e) => {
          e.preventDefault()
          content.current?.focus()
        }}
      >
        <Confetti />
        <div className="relative flex flex-col pt-8">
          <MutualMoment me={me} name={name} Title={DialogTitle} />
        </div>
        <div className="relative flex flex-col gap-1">
          <PrimaryAction label={t.verify.openChat} onClick={onOpenChat} />
          <QuietAction label={t.common.close} onClick={onClose} />
        </div>
      </SheetContent>
    </Sheet>
  )
}
