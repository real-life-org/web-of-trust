// Contact details behind the conversation head (messenger pattern; design stack kind "contact"):
// verification and trust from the library views, the counter-step, verify again.
import { useRef, useState } from 'react'
import type { ContactDetail, ContactId } from '../../port'
import { useContact, useFormat, useNav } from '../../hooks'
import { useI18n } from '../../i18n'
import { Button } from '../../ui/primitives'
import { BlockedBadge, CenteredNote, ChevronLeftIcon, DetailLine, DetailSection, PersonAvatar, TrustBadge, VerificationBadge } from '../../ui/components'
import { BlockSheet } from './BlockSheet'
import { CounterSheet } from './CounterSheet'

export function ContactDetailScreen({ contactId }: { contactId: ContactId }) {
  const { t } = useI18n()
  const contact = useContact(contactId)
  const { send } = useNav()
  if (contact.status !== 'ready' || contact.value === null) {
    return <CenteredNote text={contact.status === 'loading' ? t.shell.loading : t.chat.notFound} />
  }
  return <ContactDetailView contact={contact.value} onBack={() => send({ type: 'back' })} />
}

export function ContactDetailView({ contact: c, onBack }: { contact: ContactDetail; onBack: () => void }) {
  const { t, f } = useI18n()
  const d = t.contactDetail
  const fmt = useFormat()
  const { send } = useNav()
  const [counter, setCounter] = useState(false)
  const [blockSheet, setBlockSheet] = useState<'block' | 'unblock' | null>(null)
  const heading = useRef<HTMLHeadingElement>(null)
  const name = c.name ?? t.contacts.unnamed
  const date = c.metAt === null ? d.unknownDate : fmt.date(c.metAt)
  const verLine = (() => {
    switch (c.verification) {
      case 'mutual':
        return { main: f(d['ver.mutual'], { date }), sub: c.lastMetAt !== null && c.metAt !== null && c.lastMetAt > c.metAt ? f(d['ver.mutualRemet'], { date: fmt.date(c.lastMetAt) }) : d['ver.mutualSub'] }
      case 'incoming':
        return { main: f(d['ver.incoming'], { name, date }), sub: d['ver.incomingSub'] }
      case 'outgoing':
        return { main: f(d['ver.outgoing'], { name, date }), sub: d['ver.outgoingSub'] }
      case 'met':
        return { main: f(d['ver.met'], { name, date }), sub: null }
      case 'introduced':
        return { main: d['ver.introduced'], sub: d['ver.introducedSub'] }
    }
  })()
  const tr = c.trust
  const trustLine =
    tr.given && tr.received
      ? { main: d['trust.both'], sub: d['trust.bothSub'] }
      : tr.given
        ? { main: f(d['trust.out'], { name }), sub: d['trust.outSub'] }
        : tr.received
          ? { main: f(d['trust.in'], { name }), sub: d['trust.inSub'] }
          : { main: d['trust.none'], sub: d['trust.noneSub'] }

  return (
    <section aria-label={name} className="flex min-h-0 flex-1 flex-col bg-background text-foreground">
      <header className="flex flex-none items-center gap-2 px-3 pt-3 pb-2">
        <button type="button" onClick={onBack} aria-label={t.nav.back} className="hit-target relative flex size-11 flex-none items-center justify-center rounded-md hover:bg-muted md:size-9">
          <ChevronLeftIcon className="size-5" />
        </button>
        <h1 className="m-0 truncate text-[15px] font-semibold">{name}</h1>
      </header>
      <div className="min-h-0 flex-1 overflow-auto">
        <div className="mx-auto flex w-full max-w-[640px] flex-col gap-5 px-4 pt-2 pb-6">
          <div className="flex flex-col items-center gap-2 pt-2 pb-1 text-center">
            <PersonAvatar name={name} image={c.image} size={56} dashed={c.verification === 'introduced'} />
            <h2 ref={heading} tabIndex={-1} className="m-0 text-xl font-bold tracking-[-0.01em] outline-none">
              {name}
            </h2>
            <div className="flex flex-wrap justify-center gap-1.5">
              <VerificationBadge verification={c.verification} size="md" />
              {c.blocked ? <BlockedBadge size="md" /> : <TrustBadge trust={c.trust} withWord />}
            </div>
          </div>
          <DetailSection title={d.verification}>
            <DetailLine main={verLine.main} sub={verLine.sub} />
            <div className="flex flex-wrap gap-2">
              {c.actions.counterVerify.ok ? (
                <Button onClick={() => setCounter(true)}>{d.counterVerify}</Button>
              ) : null}
              {c.actions.verifyAgain.ok && c.verification !== 'incoming' ? (
                <Button variant="outline" onClick={() => send({ type: 'push', route: { kind: 'verify' } })}>
                  {d.verifyAgain}
                </Button>
              ) : null}
            </div>
          </DetailSection>
          <DetailSection title={d.trust}>
            <DetailLine main={trustLine.main} sub={tr.pending ? `${trustLine.sub} · ${d.pending}` : trustLine.sub} />
          </DetailSection>
          <DetailSection title={d.actions}>
            <div className="flex flex-col items-start gap-2">
              <Button variant="outline" onClick={() => send({ type: 'open', route: { kind: 'chat', key: `c:${c.id}` } })}>
                {d.openChat}
              </Button>
              {c.actions.report.ok ? (
                <Button variant="outline" className="text-destructive" onClick={() => send({ type: 'push', route: { kind: 'report', id: c.id } })}>
                  {c.blocked ? t.report.actionBlocked : t.report.action}
                </Button>
              ) : null}
              {c.actions.block.ok ? (
                <Button variant="outline" onClick={() => setBlockSheet('block')}>
                  {t.block.action}
                </Button>
              ) : null}
              {c.actions.unblock.ok ? (
                <Button variant="outline" onClick={() => setBlockSheet('unblock')}>
                  {t.block.unblockAction}
                </Button>
              ) : null}
            </div>
          </DetailSection>
        </div>
      </div>
      {blockSheet ? <BlockSheet contactId={c.id} name={name} mode={blockSheet} open onClose={() => setBlockSheet(null)} fallbackFocus={heading} /> : null}
      {/* mounted while open, whatever the availability does meanwhile (an in-flight counter-step) */}
      {counter || c.actions.counterVerify.ok ? <CounterSheet contactId={c.id} name={name} open={counter} onClose={() => setCounter(false)} fallbackFocus={heading} /> : null}
    </section>
  )
}
