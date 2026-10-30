// The success moment as a sheet (handshake UX 2.7, E7; look: artboard 2b): wherever the person is in
// the app, when the relationship becomes mutual. Both avatars, one sentence, confetti; the two actions
// of the success moment (Anton 30.10., A): trust, green, with the question before it, then the chat;
// or the chat quietly. Dismissing the sheet is the quiet close.
import { useRef, useState } from 'react'
import type { ContactId } from '../../port'
import { TrustSheet } from '../contacts/TrustSheet'
import { useI18n } from '../../i18n'
import { useContact, useProfile } from '../../hooks'
import { DialogTitle, Sheet, SheetContent } from '../../ui/primitives'
import { Confetti, MutualMoment, PrimaryAction, QuietAction, firstName } from '../../ui/components'

export function MutualSheet({ contactId, name, onOpenChat, onClose }: { contactId: ContactId; name: string; onOpenChat: () => void; onClose: () => void }) {
  const { t, f } = useI18n()
  const profile = useProfile()
  const contact = useContact(contactId)
  const given = contact.status === 'ready' && contact.value?.trust.given === true
  const [trust, setTrust] = useState(false)
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
          {given ? (
            <PrimaryAction label={t.verify.openChat} onClick={onOpenChat} />
          ) : (
            <>
              <PrimaryAction label={f(t.verify.trustPerson, { name: firstName(name) })} variant="success" onClick={() => setTrust(true)} />
              <QuietAction label={t.verify.openChat} onClick={onOpenChat} />
            </>
          )}
        </div>
        {trust ? <TrustSheet contactId={contactId} name={name} mode="on" open onClose={() => setTrust(false)} onDone={onOpenChat} fallbackFocus={content} /> : null}
      </SheetContent>
    </Sheet>
  )
}
