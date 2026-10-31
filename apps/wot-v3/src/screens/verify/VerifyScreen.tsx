// Verify in person (design: verify ready/scanner/confirm/waiting/fallback/success; architecture §4.2).
// Composition only: the state comes from useVerify, texts from i18n, pieces from ui/components.
import type { ReactNode } from 'react'
import { useRef, useState } from 'react'
import { useBackInFlow, useContact, useCopy, useFormat, useProfile, useVerify, type VerifyEvent, type VerifyState } from '../../hooks'
import type { ContactId } from '../../port'
import { TrustSheet } from '../contacts/TrustSheet'
import { useI18n } from '../../i18n'
import { Button, DialogDescription, DialogTitle, Sheet, SheetContent, useToast } from '../../ui/primitives'
import {
  AlertIcon,
  CameraIcon,
  CheckIcon,
  Callout,
  Confetti,
  Field,
  FlowPage,
  Hero,
  MutualMoment,
  KeyboardIcon,
  OutlineAction,
  PersonConfirmActions,
  PersonConfirmBody,
  PrimaryAction,
  QrCode,
  QuietAction,
  ScanIcon,
  ScannerFrame,
  firstName,
  Working,
} from '../../ui/components'

export function VerifyScreen({
  onExit,
  override,
  onState,
  link,
  onLinkTaken,
}: {
  onExit: (s: Extract<VerifyState, { name: 'exit' }>) => void
  override?: VerifyState | null
  /** the shell follows the flow: which person it asks for, so nothing asks twice (E6, E7) */
  onState?: (s: VerifyState | null) => void
  /** a card link the app was opened with (#489), taken once the own card is shown */
  link?: string | null
  onLinkTaken?: () => void
}) {
  const { state, send, scanTarget } = useVerify(onExit, override, onState, link, onLinkTaken)
  // system back is the flow's back (§4.1): never past the flow, never out of the app from inside it
  useBackInFlow(() => send({ type: 'back' }), !override)
  return <VerifyView state={state} send={send} scanTarget={scanTarget} />
}

/** The view of one machine state (also used by the screen catalog). */
export function VerifyView({ state: s, send, scanTarget }: { state: VerifyState; send: (e: VerifyEvent) => void; scanTarget?: (el: HTMLElement | null) => void }) {
  const i18n = useI18n()
  const { t, f } = i18n
  const v = t.verify
  const fmt = useFormat()
  const profile = useProfile()
  const copy = useCopy()
  const toast = useToast()
  const myName = profile.status === 'ready' ? (profile.value.name ?? t.contacts.unnamed) : ''
  const back = () => send({ type: 'back' })
  const page = (children: ReactNode, footer?: ReactNode, onBack: (() => void) | undefined = back, kind: 'back' | 'close' = 'close', titleHidden = false) => (
    <FlowPage title={v.title} onBack={onBack} backKind={kind} footer={footer} titleHidden={titleHidden}>
      {children}
    </FlowPage>
  )
  const nameOf = (n: string | null) => n ?? t.contacts.unnamed
  const link = 'hit-target relative rounded-sm text-[13px] text-muted-foreground underline underline-offset-[3px] hover:text-foreground'
  /** the shown code with its actions; also behind the camera sheet. Artboard 3: the rule under the
   *  code; copy and enter as small links, the scan in the footer */
  const readyPage = (card: VerifyState['card'], hint: Extract<VerifyState, { name: 'ready' }>['hint']) =>
    page(
      <div className="flex flex-1 flex-col items-center text-center">
        <p className="m-0 max-w-[34ch] text-sm text-pretty text-muted-foreground">{v.readyLead}</p>
        {card ? (
          <div className="mt-5 flex w-full justify-center">
            <QrCode value={card.qr} label={v.codeLabel} tooLarge={v.codeTooLarge} />
          </div>
        ) : null}
        {card ? <div className="mt-3.5 font-mono text-xs text-muted-foreground">{f(v.codeFor, { name: myName, time: fmt.time(card.expiresAt) })}</div> : null}
        <p className="m-0 mt-[18px] text-[15px] font-semibold text-pretty">{v.readyHint}</p>
        {hint ? (
          <div className="mt-4 w-full text-left">
            <Callout tone="info">{hint === 'nothing-open' ? v.nothingOpen : v.alreadyCaptured}</Callout>
          </div>
        ) : null}
        <div className="min-h-4 flex-1" />
        <div className="flex flex-wrap justify-center gap-5">
          <button
            type="button"
            className={link}
            onClick={() =>
              void copy(card?.qr ?? '').then((ok) => {
                toast.show(ok ? v.copied : v.copyFailed)
              })
            }
            title={v.copyNote}
          >
            {v.copyCode}
          </button>
          <button type="button" className={link} onClick={() => send({ type: 'manual' })}>
            {v.enterCode}
          </button>
        </div>
      </div>,
      <Button size="lg" className="w-full [&_svg]:size-[18px]" onClick={() => send({ type: 'scan' })}>
        <ScanIcon />
        {v.scanCode}
      </Button>,
    )

  switch (s.name) {
    case 'showing':
      return page(
        s.error ? (
          <Callout tone="danger" role="alert">
            {v.showFailed}
          </Callout>
        ) : (
          <Working label={v.showing} />
        ),
        s.error ? <PrimaryAction label={t.common.retry} onClick={() => send({ type: 'retry' })} /> : undefined,
      )
    case 'ready':
      return readyPage(s.card, s.hint)
    case 'cameraChecking':
    case 'scanning':
      return page(
        <div className="flex flex-1 flex-col">
          <ScannerFrame lead={v.scanLead} hint={v.scanHint} {...(scanTarget ? { viewportRef: scanTarget } : {})}>
            <Button variant="outline" onClick={back}>
              {v.cancelScan}
            </Button>
          </ScannerFrame>
        </div>,
      )
    case 'cameraExplain':
      // only where the platform explains before the system asks (Android, E3): a sheet over the shown
      // code, so the code and what the camera is for stay in view
      return (
        <>
          {readyPage(s.card, null)}
          <Sheet open onOpenChange={(open) => (!open ? back() : undefined)}>
            <SheetContent className="flex flex-col gap-4" data-camera-sheet>
              <span aria-hidden className="-mt-2 mb-[-4px] h-1 w-9 self-center rounded-full bg-border md:hidden" />
              <div className="flex items-start gap-3">
                <span className="flex size-12 flex-none items-center justify-center rounded-full bg-[color-mix(in_oklab,var(--primary)_10%,transparent)] text-primary">
                  <CameraIcon className="size-6" />
                </span>
                <div className="min-w-0 flex-1">
                  <DialogTitle className="m-0 text-lg leading-snug font-bold tracking-[-0.01em] text-balance">{v.cameraExplainTitle}</DialogTitle>
                </div>
              </div>
              <DialogDescription className="m-0 text-sm leading-relaxed text-pretty text-muted-foreground">{v.cameraExplainBody}</DialogDescription>
              <div className="flex flex-col gap-2">
                <PrimaryAction label={t.common.continue} onClick={() => send({ type: 'continue' })} />
                <QuietAction label={t.common.cancel} onClick={back} />
              </div>
            </SheetContent>
          </Sheet>
        </>
      )
    case 'cameraDenied':
      return page(
        <Hero icon={<CameraIcon />} tone="warning" title={v.cameraDeniedTitle} body={v.cameraDeniedBody} />,
        <>
          <PrimaryAction label={v.openSettings} onClick={() => send({ type: 'openSettings' })} />
          <OutlineAction label={v.enterCode} icon={<KeyboardIcon />} onClick={() => send({ type: 'manual' })} />
        </>,
        back,
        'back',
      )
    case 'cameraUnavailable':
      return page(
        <Hero icon={<CameraIcon />} tone="muted" title={v.cameraUnavailableTitle} body={v.cameraUnavailableBody} />,
        <PrimaryAction label={v.enterCode} onClick={() => send({ type: 'manual' })} />,
        back,
        'back',
      )
    case 'manualEntry':
      return page(
        <>
          <h2 className="m-0 text-lg font-semibold">{v.manualTitle}</h2>
          <Field label={v.manualLabel} hint={v.manualHint}>
            {(field) => (
              <textarea
                {...field}
                value={s.text}
                rows={4}
                autoComplete="off"
                spellCheck={false}
                placeholder={v.manualPlaceholder}
                onChange={(e) => send({ type: 'text', text: e.target.value })}
                className="w-full resize-none rounded-lg border border-border bg-background px-3 py-2 font-mono text-xs text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring"
              />
            )}
          </Field>
        </>,
        <PrimaryAction label={v.check} disabled={s.text.trim() === ''} onClick={() => send({ type: 'submit' })} />,
        back,
        'back',
      )
    case 'previewing':
      return page(<Working label={v.checking} />)
    case 'scanError':
      return page(
        <Hero icon={<AlertIcon />} tone="danger" title={v.errorTitle} body={v[`error.${s.code}`]} />,
        <PrimaryAction label={t.common.retry} onClick={() => send({ type: 'retry' })} />,
      )
    case 'confirm': {
      // the scanner: "not now" stores nothing, back to the own code
      return page(
        <PersonConfirmBody name={nameOf(s.preview.name)} when="now" />,
        <PersonConfirmActions onConfirm={() => send({ type: 'yes' })} onNotNow={() => send({ type: 'notThem' })} />,
      )
    }
    case 'committing':
      return page(<Working label={v.committing} />, undefined, undefined)
    case 'capturing':
      return page(<Working label={v.capturing} />, undefined, undefined)
    case 'waiting': {
      const name = nameOf(s.name2)
      return page(
        <>
          <div className="flex items-center gap-3">
            <span className="flex size-10 flex-none items-center justify-center rounded-full bg-[color-mix(in_oklab,var(--primary)_10%,transparent)] text-primary">
              <CheckIcon className="size-5" />
            </span>
            <div>
              <h2 className="m-0 text-lg font-semibold">{f(v.waitTitle, { name })}</h2>
              <div className="text-[13px] text-muted-foreground">→ {v.oneSidedNow}</div>
            </div>
          </div>
          <p className="m-0 text-sm text-pretty text-muted-foreground">{f(v.waitBody, { name: name.split(' ')[0] ?? name })}</p>
          <Callout tone="warning" role="status">
            <div className="flex flex-col gap-2.5">
              <span>{s.waitLong ? v.waitNoteLong : v.waitNote}</span>
              {/* the optical return path is open from the start, never behind a timer (RLTP-ENC-5680) */}
              <div className="flex flex-wrap gap-2">
                <Button variant="outline" size="sm" onClick={() => send({ type: 'showCode' })}>
                  {v.showCodeInstead}
                </Button>
                {s.waitLong ? (
                  <Button variant="outline" size="sm" onClick={() => send({ type: 'keepWaiting' })}>
                    {v.keepWaiting}
                  </Button>
                ) : null}
              </div>
            </div>
          </Callout>
        </>,
        <QuietAction label={v.backToChat} onClick={() => send({ type: 'leave' })} />,
        () => send({ type: 'leave' }),
      )
    }
    case 'loadingFallback':
      return page(<Working label={v.showing} />, undefined, undefined)
    case 'fallback': {
      const name = nameOf(s.name2)
      return page(
        <div className="flex flex-col items-center gap-4 text-center">
          <h2 className="m-0 text-lg font-semibold">{v.fallbackTitle}</h2>
          <p className="m-0 text-sm text-pretty text-muted-foreground">{f(v.fallbackBody, { name: name.split(' ')[0] ?? name })}</p>
          <QrCode value={s.sentQr} label={v.fallbackLabel} tooLarge={v.codeTooLarge} />
        </div>,
        <QuietAction label={v.backToChat} onClick={() => send({ type: 'leave' })} />,
        () => send({ type: 'leave' }),
      )
    }
    case 'confirmationRequired':
    case 'confirmIncoming':
      // the shower, the same confirmation as the scanner's (E4): "not now" leaves the decision open
      return page(
        <PersonConfirmBody name={nameOf(s.name2)} when="now" scanned failed={s.name === 'confirmIncoming' && s.failed} />,
        <PersonConfirmActions busy={s.busy} onConfirm={() => send({ type: 'accept' })} onNotNow={() => send({ type: 'notNow' })} />,
        () => send({ type: s.name === 'confirmIncoming' ? 'notNow' : 'leave' }),
      )
    case 'counterPending': {
      const name = nameOf(s.name2)
      return page(
        <Hero icon={<CheckIcon />} title={v.counterPendingTitle} body={f(v.counterPendingBody, { name })} />,
        <QuietAction label={v.backToChat} onClick={() => send({ type: 'leave' })} />,
        () => send({ type: 'leave' }),
      )
    }
    case 'success': {
      // artboard 2b: both avatars, one sentence, confetti (none under reduced motion)
      const name = nameOf(s.name2)
      return (
        <div className="relative flex min-h-0 flex-1 flex-col">
          {s.isNew ? <Confetti /> : null}
          {page(
            <MutualMoment me={myName || t.contacts.unnamed} name={name} />,
            <SuccessActions contactId={s.contactId} name={name} onChat={() => send({ type: 'done' })} />,
            () => send({ type: 'done' }),
            'close',
            true,
          )}
        </div>
      )
    }
    case 'exit':
      return null
  }
}

/** The success moment's two actions (Anton 30.10., A): trust, green, with the question before it,
 *  then on to the chat; or the chat quietly. Trust already given: only the chat. */
function SuccessActions({ contactId, name, onChat }: { contactId: ContactId; name: string; onChat: () => void }) {
  const { t, f } = useI18n()
  const contact = useContact(contactId)
  const given = contact.status === 'ready' && contact.value?.trust.given === true
  const [sheet, setSheet] = useState(false)
  const focus = useRef<HTMLElement | null>(null)
  return (
    <>
      {given ? (
        <PrimaryAction label={t.verify.openChat} onClick={onChat} />
      ) : (
        <>
          <PrimaryAction label={f(t.verify.trustPerson, { name: firstName(name) })} variant="success" onClick={() => setSheet(true)} />
          <QuietAction label={t.verify.openChat} onClick={onChat} />
        </>
      )}
      {sheet ? <TrustSheet contactId={contactId} name={name} mode="on" open onClose={() => setSheet(false)} onDone={onChat} fallbackFocus={focus} /> : null}
    </>
  )
}
