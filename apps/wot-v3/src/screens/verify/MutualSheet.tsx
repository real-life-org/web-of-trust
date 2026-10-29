// The success moment as a sheet (handshake UX 2.7, E7): wherever the person is in the app, when the
// relationship becomes mutual. The existing success look (the flow's `success`); the form is PR B's.
import { useI18n } from '../../i18n'
import { DialogDescription, DialogTitle, Sheet, SheetContent } from '../../ui/primitives'
import { Confetti, PrimaryAction, QuietAction, VerifyIcon } from '../../ui/components'

export function MutualSheet({ name, onOpenChat, onClose }: { name: string; onOpenChat: () => void; onClose: () => void }) {
  const { t, f } = useI18n()
  const v = t.verify
  return (
    <Sheet open onOpenChange={(o) => (!o ? onClose() : undefined)}>
      <SheetContent className="flex flex-col gap-4 overflow-hidden" aria-live="polite">
        <Confetti />
        <div className="flex flex-col items-center gap-3 pt-2 text-center">
          <span className="flex size-16 items-center justify-center rounded-full bg-[color-mix(in_oklab,var(--primary)_10%,transparent)] text-primary-strong [&_svg]:size-[30px]">
            <VerifyIcon />
          </span>
          <DialogTitle className="m-0 text-[22px] leading-tight font-bold tracking-[-0.02em] text-balance">{v.successTitle}</DialogTitle>
          <DialogDescription className="m-0 max-w-[40ch] text-sm text-pretty text-muted-foreground">{f(v.successBody, { name })}</DialogDescription>
        </div>
        <div className="flex flex-col gap-2">
          <PrimaryAction label={v.openChat} onClick={onOpenChat} />
          <QuietAction label={t.common.close} onClick={onClose} />
        </div>
      </SheetContent>
    </Sheet>
  )
}
