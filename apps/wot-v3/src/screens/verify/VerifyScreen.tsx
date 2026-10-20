// Verify in person (design: verify ready/scanner/confirm/waiting/fallback/success; architecture §4.2).
// Composition only: the state comes from useVerify, texts from i18n, pieces from ui/components.
import type { ReactNode } from 'react'
import { useCopy, useFormat, useProfile, useVerify, type VerifyEvent, type VerifyState } from '../../hooks'
import { useI18n } from '../../i18n'
import { Button, useToast } from '../../ui/primitives'
import {
  AlertIcon,
  CameraIcon,
  CheckIcon,
  Callout,
  Confetti,
  CopyIcon,
  Field,
  FlowPage,
  Hero,
  KeyboardIcon,
  OutlineAction,
  PersonAvatar,
  PrimaryAction,
  QrCode,
  QuietAction,
  ScanIcon,
  ScannerFrame,
  VerifyIcon,
  Working,
} from '../../ui/components'

export function VerifyScreen({ onExit, override }: { onExit: (s: Extract<VerifyState, { name: 'exit' }>) => void; override?: VerifyState | null }) {
  const { state, send } = useVerify(onExit, override)
  return <VerifyView state={state} send={send} />
}

/** The view of one machine state (also used by the screen catalog). */
export function VerifyView({ state: s, send }: { state: VerifyState; send: (e: VerifyEvent) => void }) {
  const i18n = useI18n()
  const { t, f } = i18n
  const v = t.verify
  const fmt = useFormat()
  const profile = useProfile()
  const copy = useCopy()
  const toast = useToast()
  const myName = profile.status === 'ready' ? (profile.value.name ?? t.contacts.unnamed) : ''
  const back = () => send({ type: 'back' })
  const page = (children: ReactNode, footer?: ReactNode, onBack: (() => void) | undefined = back, kind: 'back' | 'close' = 'close') => (
    <FlowPage title={v.title} onBack={onBack} backKind={kind} footer={footer}>
      {children}
    </FlowPage>
  )
  const nameOf = (n: string | null) => n ?? t.contacts.unnamed

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
    case 'ready': {
      const card = s.card
      return page(
        <div className="flex flex-col items-center gap-[18px]">
          <p className="m-0 text-center text-sm text-pretty text-muted-foreground">{v.readyLead}</p>
          {card ? <QrCode value={card.qr} label={v.codeLabel} /> : null}
          {card ? <div className="font-mono text-xs text-muted-foreground">{f(v.codeFor, { name: myName, time: fmt.time(card.expiresAt) })}</div> : null}
          {s.hint === 'already-captured' ? <Callout tone="info">{v.alreadyCaptured}</Callout> : null}
          <p className="m-0 text-center text-xs text-pretty text-muted-foreground">{v.readyHint}</p>
          <div className="flex flex-wrap justify-center gap-2">
            <Button
              variant="ghost"
              className="h-11 md:h-9"
              onClick={() =>
                void copy(card?.qr ?? '').then((ok) => {
                  toast.show(ok ? v.copied : v.copyFailed)
                })
              }
              title={v.copyNote}
            >
              <CopyIcon />
              {v.copyCode}
            </Button>
            <Button variant="ghost" className="h-11 md:h-9" onClick={() => send({ type: 'manual' })}>
              <KeyboardIcon />
              {v.enterCode}
            </Button>
          </div>
        </div>,
        <Button size="lg" className="w-full [&_svg]:size-[18px]" onClick={() => send({ type: 'scan' })}>
          <ScanIcon />
          {v.scanCode}
        </Button>,
      )
    }
    case 'cameraChecking':
    case 'scanning':
      return page(
        <div className="-mx-5 -mb-6 flex flex-1 flex-col">
          <ScannerFrame lead={v.scanLead} hint={v.scanHint}>
            <Button variant="outline" className="border-[oklch(40%_0.01_265)] bg-transparent text-[oklch(90%_0.01_265)] hover:bg-[oklch(30%_0.01_265)]" onClick={back}>
              {v.cancelScan}
            </Button>
          </ScannerFrame>
        </div>,
      )
    case 'cameraExplain':
      return page(<Hero icon={<CameraIcon />} title={v.cameraExplainTitle} body={v.cameraExplainBody} />, <PrimaryAction label={t.common.continue} onClick={() => send({ type: 'continue' })} />, back, 'back')
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
          <h1 className="m-0 text-lg font-semibold">{v.manualTitle}</h1>
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
      const name = s.preview.name
      return page(
        <div className="flex flex-col items-center gap-[18px] pt-4 text-center">
          <PersonAvatar name={nameOf(name)} size={56} />
          <h1 className="m-0 text-[22px] leading-tight font-bold tracking-[-0.02em] text-balance">{name ? f(v.confirmQuestion, { name }) : v.confirmQuestionUnnamed}</h1>
          <p className="m-0 text-sm text-pretty text-muted-foreground">{v.confirmSub}</p>
        </div>,
        <>
          <PrimaryAction label={name ? f(v.confirmYes, { name: name.split(' ')[0] ?? name }) : v.confirmYesUnnamed} onClick={() => send({ type: 'yes' })} />
          <QuietAction label={v.notThem} onClick={() => send({ type: 'notThem' })} />
        </>,
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
              <h1 className="m-0 text-lg font-semibold">{f(v.waitTitle, { name })}</h1>
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
          <h1 className="m-0 text-lg font-semibold">{v.fallbackTitle}</h1>
          <p className="m-0 text-sm text-pretty text-muted-foreground">{f(v.fallbackBody, { name: name.split(' ')[0] ?? name })}</p>
          <QrCode value={s.sentQr} label={v.fallbackLabel} />
        </div>,
        <QuietAction label={v.backToChat} onClick={() => send({ type: 'leave' })} />,
        () => send({ type: 'leave' }),
      )
    }
    case 'confirmationRequired': {
      const name = nameOf(s.name2)
      return page(
        <div className="flex flex-col items-center gap-[18px] pt-4 text-center">
          <PersonAvatar name={name} size={56} />
          <h1 className="m-0 text-[22px] leading-tight font-bold tracking-[-0.02em] text-balance">{f(v.confirmationTitle, { name })}</h1>
          <p className="m-0 text-sm text-pretty text-muted-foreground">{f(v.confirmationBody, { name })}</p>
        </div>,
        <>
          <PrimaryAction label={v.confirmationYes} busy={s.busy} onClick={() => send({ type: 'accept' })} />
          <QuietAction label={v.confirmationNo} disabled={s.busy} onClick={() => send({ type: 'decline' })} />
        </>,
        () => send({ type: 'leave' }),
      )
    }
    case 'counterPending': {
      const name = nameOf(s.name2)
      return page(
        <Hero icon={<CheckIcon />} title={v.counterPendingTitle} body={f(v.counterPendingBody, { name })} />,
        <QuietAction label={v.backToChat} onClick={() => send({ type: 'leave' })} />,
        () => send({ type: 'leave' }),
      )
    }
    case 'success': {
      const name = nameOf(s.name2)
      return (
        <div className="relative flex min-h-0 flex-1 flex-col">
          {s.isNew ? <Confetti /> : null}
          {page(
            <div className="flex flex-1 flex-col justify-center">
              <Hero icon={<VerifyIcon />} title={v.successTitle} body={f(v.successBody, { name })} />
            </div>,
            <PrimaryAction label={v.openChat} onClick={() => send({ type: 'done' })} />,
            () => send({ type: 'done' }),
          )}
        </div>
      )
    }
    case 'exit':
      return null
  }
}
