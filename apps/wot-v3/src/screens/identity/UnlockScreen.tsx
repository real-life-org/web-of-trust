// Unlock (architecture §4.2 "Entsperren"): structure and copy of legacy UnlockFlow.tsx and
// BiometricOptIn.tsx; one path per protection mode, passphrase fallback that never depends on
// platform error codes, biometrics offered once.
import type { UnlockEvent, UnlockState } from '../../hooks'
import { secret } from '../../hooks'
import { useI18n } from '../../i18n'
import { Sheet, SheetContent, DialogTitle, DialogDescription } from '../../ui/primitives'
import {
  AlertIcon,
  Callout,
  FingerprintIcon,
  FlowPage,
  Hero,
  LockIcon,
  OutlineAction,
  PassphraseInput,
  PrimaryAction,
  QuietAction,
  ShieldIcon,
  Working,
} from '../../ui/components'

/** Why the identity is locked, shown above the unlock (§5: the background lock). */
export type UnlockNotice = 'background-timeout' | null

export function UnlockScreen({ state: s, send, notice = null }: { state: UnlockState; send: (e: UnlockEvent) => void; notice?: UnlockNotice }) {
  const { t, f } = useI18n()
  const lockedNote = notice === 'background-timeout' ? <Callout tone="info">{t.unlock.lockedInBackground}</Callout> : null
  const recover = <QuietAction label={t.unlock.recoverLink} onClick={() => send({ type: 'recover' })} />
  const resume = 'mode' in s && s.mode === 'resume-setup'
  const title = resume ? t.unlock.resumeTitle : t.app.name

  switch (s.name) {
    case 'biometricPrompt': {
      const kind = s.lock.biometric ? t.biometricKind[s.lock.biometric] : ''
      return (
        <FlowPage
          title={title}
          footer={
            <>
              {s.lock.protection === 'passphrase+biometric' ? <OutlineAction label={t.unlock.usePassphrase} onClick={() => send({ type: 'usePassphrase' })} /> : null}
              {recover}
            </>
          }
        >
          <div className="flex flex-1 flex-col justify-center gap-[18px]">
            <Hero icon={<FingerprintIcon />} title={resume ? t.unlock.resumeTitle : t.unlock.title} body={resume ? t.unlock.resumeSubtitle : f(t.unlock.biometricLead, { kind })} />
            {lockedNote}
            <Working label={t.unlock.biometricUnlocking} />
          </div>
        </FlowPage>
      )
    }
    case 'biometricRetry':
      return (
        <FlowPage title={title} footer={<>{<PrimaryAction label={t.unlock.biometricButton} onClick={() => send({ type: 'retry' })} />}{recover}</>}>
          <div className="flex flex-1 flex-col justify-center gap-[18px]">
            <Hero icon={<FingerprintIcon />} title={t.unlock.retryTitle} body={t.unlock.retryBody} />
            {lockedNote}
          </div>
        </FlowPage>
      )
    case 'biometricLost':
      return (
        <FlowPage
          title={title}
          footer={
            <>
              <PrimaryAction label={t.unlock.recoverLink} onClick={() => send({ type: 'recover' })} />
              <QuietAction label={t.unlock.deleteButton} onClick={() => send({ type: 'delete' })} />
            </>
          }
        >
          <Hero icon={<FingerprintIcon />} tone="warning" title={t.unlock.lostTitle} />
          <Callout tone="warning">{t.unlock.lostBody}</Callout>
        </FlowPage>
      )
    case 'unsupported':
      return (
        <FlowPage
          title={t.app.name}
          footer={
            <>
              <PrimaryAction label={t.unlock.recoverLink} onClick={() => send({ type: 'recover' })} />
              <QuietAction label={t.unlock.deleteButton} onClick={() => send({ type: 'delete' })} />
            </>
          }
        >
          <Hero icon={<AlertIcon />} tone="warning" title={t.unlock.unsupportedTitle} body={t.unlock.unsupportedBody} />
        </FlowPage>
      )
    case 'stateUnreadable':
      return (
        <FlowPage
          title={title}
          footer={
            <>
              <PrimaryAction label={t.unlock.recoverLink} onClick={() => send({ type: 'recover' })} />
              <QuietAction label={t.unlock.deleteButton} onClick={() => send({ type: 'delete' })} />
            </>
          }
        >
          <Hero icon={<AlertIcon />} tone="warning" title={t.stateUnreadable.title} body={t.stateUnreadable[s.cause]} />
          <Callout tone="warning">{t.stateUnreadable.unlockActions}</Callout>
        </FlowPage>
      )
    case 'passphrase': {
      const value = s.value.reveal()
      const submit = () => send({ type: 'submit' })
      const error = s.error === 'wrong' ? t.unlock.errorWrongPassword : s.error === 'empty' ? t.unlock.errorNoPassword : null
      return (
        <FlowPage
          title={title}
          footer={
            <>
              <PrimaryAction label={s.busy ? t.unlock.unlocking : t.unlock.unlockButton} onClick={submit} busy={s.busy} disabled={value === ''} />
              {s.hint === 'bioFailed' ? <OutlineAction label={t.unlock.retryBiometric} icon={<FingerprintIcon />} onClick={() => send({ type: 'retry' })} disabled={s.busy} /> : null}
              {recover}
            </>
          }
        >
          <Hero icon={<LockIcon />} title={resume ? t.unlock.resumeTitle : t.unlock.title} body={resume ? t.unlock.resumeSubtitle : t.unlock.subtitle} />
          {lockedNote}
          {s.hint === 'bioUnusable' ? <Callout tone="warning">{t.unlock.hintBioUnusable}</Callout> : null}
          {s.hint === 'bioFailed' ? <Callout tone="info">{t.unlock.hintBioFailed}</Callout> : null}
          <PassphraseInput
            label={t.unlock.passwordLabel}
            value={value}
            onChange={(v) => send({ type: 'value', value: secret(v) })}
            onEnter={submit}
            placeholder={t.unlock.passwordPlaceholder}
            autoComplete="current-password"
            autoFocus
            error={error}
          />
        </FlowPage>
      )
    }
    case 'opening':
      return (
        <FlowPage title={title}>
          <Working label={t.unlock.opening} />
        </FlowPage>
      )
    case 'otherWriter':
      return (
        <FlowPage title={title} footer={<PrimaryAction label={t.common.retry} onClick={() => send({ type: 'retry' })} />}>
          <Hero icon={<LockIcon />} tone="muted" title={t.identitySystem.otherWriterTitle} body={t.identitySystem.otherWriterBody} />
        </FlowPage>
      )
    case 'resumeInit':
    case 'resumeActivate':
      if (s.error)
        return (
          <FlowPage title={title} footer={<PrimaryAction label={t.common.retry} onClick={() => send({ type: 'retry' })} />}>
            <Hero icon={<AlertIcon />} tone="warning" title={t.onboarding.initErrorTitle} />
            <Callout tone="warning" role="alert">
              {t.onboarding.initErrorBody}
            </Callout>
          </FlowPage>
        )
      return (
        <FlowPage title={title}>
          <Working label={t.unlock.resumeInit} />
        </FlowPage>
      )
    case 'repairProtection':
      if (s.error)
        return (
          <FlowPage title={title} footer={<PrimaryAction label={t.common.retry} onClick={() => send({ type: 'retry' })} />}>
            <Hero icon={<ShieldIcon />} tone="warning" title={t.unlock.repairErrorTitle} />
            <Callout tone="warning" role="alert">
              {t.unlock.repairErrorBody}
            </Callout>
          </FlowPage>
        )
      return (
        <FlowPage title={title}>
          <Working label={t.unlock.repairing} />
        </FlowPage>
      )
    case 'repairKeystore':
      return (
        <OpenBehind title={title}>
          <BiometricSheet
            title={t.unlock.repairKeystoreTitle}
            body={t.unlock.repairKeystoreBody}
            confirm={s.busy ? t.biometric.enrolling : t.unlock.repairKeystoreButton}
            dismiss={t.unlock.notNow}
            busy={s.busy}
            onConfirm={() => send({ type: 'enable' })}
            onDismiss={() => send({ type: 'skip' })}
          />
        </OpenBehind>
      )
    case 'offerBiometric': {
      const kind = s.lock.biometric ? t.biometricKind[s.lock.biometric] : t.biometricKind.fingerprint
      return (
        <OpenBehind title={title}>
          <BiometricSheet
            title={t.biometric.title}
            body={f(t.biometric.enablePrompt, { kind })}
            confirm={s.busy ? t.biometric.enrolling : t.biometric.enable}
            dismiss={t.biometric.notNow}
            busy={s.busy}
            onConfirm={() => send({ type: 'enable' })}
            onDismiss={() => send({ type: 'notNow' })}
          />
        </OpenBehind>
      )
    }
    case 'exit':
      return null
  }
}

/** The page behind an offer sheet: the unlock is done, the app is about to show. */
function OpenBehind({ title, children }: { title: string; children: React.ReactNode }) {
  const { t } = useI18n()
  return (
    <FlowPage title={title}>
      <div className="flex flex-1 flex-col justify-center">
        <Hero icon={<LockIcon />} tone="success" title={t.unlock.title} />
      </div>
      {children}
    </FlowPage>
  )
}

/** Bottom sheet in the prototype's decision style (legacy BiometricOptIn as a sheet). */
function BiometricSheet(p: { title: string; body: string; confirm: string; dismiss: string; busy: boolean; onConfirm: () => void; onDismiss: () => void }) {
  return (
    <Sheet open onOpenChange={(open) => !open && !p.busy && p.onDismiss()}>
      <SheetContent className="flex flex-col gap-4">
        <span aria-hidden className="-mt-2 mb-[-4px] h-1 w-9 self-center rounded-full bg-border md:hidden" />
        <div className="flex items-start gap-3">
          <span className="flex size-12 flex-none items-center justify-center rounded-full bg-[color-mix(in_oklab,var(--primary)_10%,transparent)] text-primary">
            <FingerprintIcon className="size-6" />
          </span>
          <div className="min-w-0 flex-1">
            <DialogTitle className="m-0 text-lg leading-snug font-bold tracking-[-0.01em] text-balance">{p.title}</DialogTitle>
          </div>
        </div>
        <DialogDescription className="m-0 text-sm leading-relaxed text-pretty text-muted-foreground">{p.body}</DialogDescription>
        <div className="flex flex-col gap-2">
          <PrimaryAction label={p.confirm} onClick={p.onConfirm} busy={p.busy} />
          <QuietAction label={p.dismiss} onClick={p.onDismiss} disabled={p.busy} />
        </div>
      </SheetContent>
    </Sheet>
  )
}
