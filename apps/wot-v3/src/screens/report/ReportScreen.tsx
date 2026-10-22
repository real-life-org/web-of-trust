// Report and block (paper §6): notice page, choice of messages with a preview of the mail, block on
// confirm, mail draft (or share sheet for a long transcript), copy fallback without a mail app. For a
// blocked contact the choice also shows the messages the conversation hides, with a note; this screen
// is the only place they appear (Anton 21.10.).
import type { ContactId, MessageItem } from '../../port'
import { MAX_REPORT_MESSAGES, REPORT_ADDRESS, useBackInFlow, useContact, useFormat, useReport, useReportable, useReportMail, type ReportEvent, type ReportState } from '../../hooks'
import { useI18n } from '../../i18n'
import { Button } from '../../ui/primitives'
import { AlertIcon, Callout, CenteredNote, CheckIcon, CheckRow, CopyIcon, FlowPage, Hero, PrimaryAction, QuietAction, ShieldIcon, Working } from '../../ui/components'

export function ReportScreen({ contactId, onExit }: { contactId: ContactId; onExit: (to: 'back' | 'chat') => void }) {
  const { t } = useI18n()
  const contact = useContact(contactId)
  const reportable = useReportable(contactId)
  if (contact.status !== 'ready' || !contact.value || reportable.status !== 'ready') return <CenteredNote text={t.shell.loading} />
  return <ReportFlowView contactId={contactId} name={contact.value.name ?? t.contacts.unnamed} blocked={contact.value.blocked} messages={reportable.value} onExit={onExit} />
}

function ReportFlowView({ contactId, name, blocked, messages, onExit }: { contactId: ContactId; name: string; blocked: boolean; messages: readonly MessageItem[]; onExit: (to: 'back' | 'chat') => void }) {
  const { state, send } = useReport(
    contactId,
    messages.map((m) => m.id),
    (s) => onExit(s.to),
  )
  // system back is the flow's back (§4.1); the report never leaves the app from inside it
  useBackInFlow(() => send({ type: 'back' }))
  return <ReportView state={state} send={send} name={name} blocked={blocked} messages={messages} />
}

/** The view of one machine state (also used by the screen catalog). */
export function ReportView({ state: s, send, name, blocked = false, messages }: { state: ReportState; send: (e: ReportEvent) => void; name: string; blocked?: boolean; messages: readonly MessageItem[] }) {
  const { t, f } = useI18n()
  const r = t.report
  const fmt = useFormat()
  const mailOf = useReportMail(name, messages)
  const back = () => send({ type: 'back' })
  // `null` means no back button: an explicit `undefined` would fall back to the default (review 422 CodeRabbit)
  const page = (children: React.ReactNode, footer?: React.ReactNode, onBack: (() => void) | null = back) => (
    <FlowPage title={blocked ? r.actionBlocked : r.title} onBack={onBack ?? undefined} backKind={s.name === 'info' ? 'close' : 'back'} footer={footer}>
      {children}
    </FlowPage>
  )
  switch (s.name) {
    case 'info':
      return page(
        <>
          <Hero icon={<ShieldIcon />} tone="warning" title={f(r.infoTitle, { name })} />
          <ul className="m-0 flex list-none flex-col gap-3 p-0 text-sm text-pretty">
            {[r.infoApp, r.infoInform, r.infoSent, blocked ? r.infoBlocked : r.infoBlock, r.infoCounts].map((x, i) => (
              <li key={i} className="flex gap-2.5">
                <span aria-hidden className="mt-2 size-1.5 flex-none rounded-full bg-muted-foreground" />
                <span>{f(x, { name })}</span>
              </li>
            ))}
          </ul>
        </>,
        <PrimaryAction label={t.common.continue} onClick={() => send({ type: 'next' })} />,
      )
    case 'selecting':
      return page(
        <>
          <div>
            <h2 className="m-0 text-lg font-semibold">{r.selectTitle}</h2>
            <p className="m-0 mt-1 text-xs text-muted-foreground">{f(r.selectHint, { max: MAX_REPORT_MESSAGES })}</p>
          </div>
          {blocked ? <Callout tone="warning">{f(r.hiddenHint, { name })}</Callout> : null}
          <div role="status" className="text-xs font-medium text-muted-foreground">
            {f(r.selected, { count: s.selected.length, max: MAX_REPORT_MESSAGES })}
          </div>
          <div className="flex flex-col divide-y divide-border rounded-lg border border-border bg-card">
            {messages.map((m) => (
              <CheckRow
                key={m.id}
                label={`${m.author.kind === 'self' ? r.me : name} · ${fmt.time(m.at)}`}
                checked={s.selected.includes(m.id)}
                onChange={() => send({ type: 'toggle', id: m.id })}
                hint={<span className="line-clamp-2 text-foreground">{m.text}</span>}
              />
            ))}
          </div>
        </>,
        <PrimaryAction label={t.common.continue} disabled={s.selected.length === 0} onClick={() => send({ type: 'next' })} />,
      )
    case 'review': {
      const mail = mailOf(s.selected)
      return page(
        <>
          <h2 className="m-0 text-lg font-semibold">{r.reviewTitle}</h2>
          <dl className="m-0 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm">
            <dt className="text-muted-foreground">{r.to}</dt>
            <dd className="m-0 font-mono text-[13px]">{mail.to}</dd>
            <dt className="text-muted-foreground">{r.subjectLabel}</dt>
            <dd className="m-0">{mail.subject}</dd>
          </dl>
          <pre className="m-0 max-h-[40vh] overflow-auto rounded-lg border border-border bg-card p-3 font-mono text-xs whitespace-pre-wrap [overflow-wrap:anywhere]">
            {mail.file ? `${mail.body}\n\n— ${mail.file.name} —\n${mail.file.text}` : mail.body}
          </pre>
          {mail.file ? <p className="m-0 text-xs text-muted-foreground">{f(r.attachedHint, { count: s.selected.length })}</p> : null}
          {blocked ? null : <Callout tone="warning">{f(r.blockNote, { name })}</Callout>}
        </>,
        <>
          <PrimaryAction label={blocked ? r.confirmBlocked : r.confirm} variant="destructive" onClick={() => send({ type: 'confirm', mail })} />
          <QuietAction label={t.common.back} onClick={back} />
        </>,
      )
    }
    case 'blocking':
    case 'composing':
      // the machine has no back row while the block or the mail composition runs
      return page(<Working label={r.working} />, undefined, null)
    case 'blockFailed':
      return page(
        <Callout tone="danger" role="alert">
          {r.blockFailed}
        </Callout>,
        <PrimaryAction label={t.common.retry} onClick={() => send({ type: 'retry' })} />,
      )
    case 'handedOver': {
      // a long transcript went through the share sheet, not as a mail draft (review 422 CodeRabbit)
      const shared = s.mail.file !== null
      return page(
        <Hero icon={<CheckIcon />} tone="success" title={shared ? r.sharedTitle : r.handedTitle} body={f(shared ? r.sharedBody : r.handedBody, { name })} />,
        <>
          <PrimaryAction label={r.done} onClick={() => send({ type: 'done' })} />
          <QuietAction label={shared ? r.shareAgain : r.openAgain} onClick={() => send({ type: 'openMail' })} />
          <QuietAction label={r.noMailApp} onClick={() => send({ type: 'noMailApp' })} />
        </>,
        () => send({ type: 'done' }),
      )
    }
    case 'fallback':
      return page(
        <>
          <Hero icon={<AlertIcon />} tone="warning" title={f(r.fallbackTitle, { address: REPORT_ADDRESS })} body={r.fallbackBody} />
          <div className="flex flex-col gap-1.5">
            <span className="text-sm font-medium">{r.address}</span>
            <div className="flex items-center gap-2">
              <code className="min-w-0 flex-1 truncate rounded-md border border-border bg-card px-3 py-2 text-[13px]">{s.mail.to}</code>
              <Button variant="outline" onClick={() => send({ type: 'copy', what: 'address' })}>
                <CopyIcon />
                {r.copyAddress}
              </Button>
            </div>
          </div>
          <div className="flex flex-col gap-1.5">
            <span className="text-sm font-medium">{r.text}</span>
            <textarea
              readOnly
              aria-label={r.text}
              value={s.mail.full}
              rows={8}
              className="w-full resize-none rounded-lg border border-border bg-card px-3 py-2 font-mono text-xs text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring"
            />
            <Button variant="outline" className="self-start" onClick={() => send({ type: 'copy', what: 'text' })}>
              <CopyIcon />
              {r.copyText}
            </Button>
          </div>
          {s.copied || s.copyFailed ? (
            <Callout tone={s.copyFailed ? 'danger' : 'success'} role="status">
              {s.copyFailed ? r.copyFailed : r.copied}
            </Callout>
          ) : null}
        </>,
        <>
          <PrimaryAction label={r.done} onClick={() => send({ type: 'done' })} />
          <QuietAction label={r.tryMail} onClick={() => send({ type: 'openMail' })} />
        </>,
        () => send({ type: 'done' }),
      )
    case 'exit':
      return null
  }
}
