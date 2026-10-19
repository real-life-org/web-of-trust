// Change protection (architecture §4.2 "Schutz ändern"), reached from the profile tab. No legacy
// screen (legacy asked the password with window.prompt, DA §3 "Schwächen"): own structure, prototype look.
import type { ProtectionEvent, ProtectionState } from '../../hooks'
import { secret, MIN_PASSPHRASE } from '../../hooks'
import { useI18n } from '../../i18n'
import {
  Callout,
  CheckIcon,
  ChoiceCard,
  FingerprintIcon,
  FlowPage,
  Hero,
  KeyIcon,
  PassphraseInput,
  PrimaryAction,
  ShieldIcon,
  Working,
} from '../../ui/components'

export function ProtectionScreen({ state: s, send }: { state: ProtectionState; send: (e: ProtectionEvent) => void }) {
  const { t, f } = useI18n()
  const title = t.protection.title
  const close = () => send({ type: 'close' })
  switch (s.name) {
    case 'choose': {
      const options = [
        { target: 'passphrase+biometric' as const, title: t.protection.choosePassphraseBiometric, sub: t.protection.choosePassphraseBiometricSub, icon: <FingerprintIcon />, needsBio: true },
        { target: 'passphrase' as const, title: t.protection.choosePassphrase, sub: t.protection.choosePassphraseSub, icon: <KeyIcon />, needsBio: false },
      ].filter((o) => o.target !== s.current)
      return (
        <FlowPage title={title} onBack={close} backKind="close">
          <Hero icon={<ShieldIcon />} title={title} body={f(t.protection.current, { mode: t.protection.mode[s.current] })} />
          {s.error === 'last-access' ? (
            <Callout tone="warning" role="alert">
              {t.protection.lastAccess}
            </Callout>
          ) : null}
          <div className="flex flex-col gap-2.5">
            {options.map((o) => (
              <ChoiceCard
                key={o.target}
                icon={o.icon}
                title={o.title}
                sub={o.needsBio && s.biometric === null && s.current !== 'biometric-only' ? t.protect.biometricUnavailable : o.sub}
                disabled={o.needsBio && s.biometric === null && s.current !== 'biometric-only'}
                onClick={() => send({ type: 'select', target: o.target })}
              />
            ))}
          </div>
        </FlowPage>
      )
    }
    case 'proveCurrent': {
      const value = s.value.reveal()
      const submit = () => send({ type: 'submit' })
      return (
        <FlowPage title={title} onBack={close} backKind="close" footer={<PrimaryAction label={t.protection.confirm} onClick={submit} busy={s.busy} disabled={value === ''} />}>
          <Hero icon={<KeyIcon />} title={t.protection.proveTitle} />
          <PassphraseInput
            label={t.unlock.passwordLabel}
            value={value}
            onChange={(v) => send({ type: 'value', value: secret(v) })}
            onEnter={submit}
            autoComplete="current-password"
            autoFocus
            error={s.error === 'wrong' ? t.unlock.errorWrongPassword : null}
          />
        </FlowPage>
      )
    }
    case 'provingBiometric':
      return (
        <FlowPage
          title={title}
          onBack={close}
          backKind="close"
          footer={s.error ? <PrimaryAction label={t.common.retry} onClick={() => send({ type: 'retry' })} /> : undefined}
        >
          <Hero icon={<FingerprintIcon />} title={t.protection.proveBiometricTitle} body={t.protection.proveBiometricBody} />
          {s.error ? (
            <Callout tone="warning" role="alert">
              {t.protection.biometricCancelled}
            </Callout>
          ) : (
            <Working label={t.unlock.biometricUnlocking} />
          )}
        </FlowPage>
      )
    case 'newPassphrase': {
      const p1 = s.p1.reveal()
      const p2 = s.p2.reveal()
      const mismatch = p1.length > 0 && p2.length > 0 && p1 !== p2
      const ready = p1.length >= MIN_PASSPHRASE && p1 === p2
      const submit = () => ready && send({ type: 'submit' })
      return (
        <FlowPage title={title} onBack={close} backKind="close" footer={<PrimaryAction label={t.protection.confirm} onClick={submit} disabled={!ready} />}>
          <Hero icon={<KeyIcon />} tone="success" title={t.protection.newPassphraseTitle} body={t.protection.newPassphraseBody} />
          <PassphraseInput
            label={t.common.passwordLabel}
            value={p1}
            onChange={(v) => send({ type: 'p1', value: secret(v) })}
            onEnter={submit}
            placeholder={t.common.passwordPlaceholder}
            autoComplete="new-password"
            autoFocus
            hint={p1.length > 0 && p1.length < MIN_PASSPHRASE ? t.common.passwordMinLength : undefined}
          />
          <PassphraseInput
            label={t.common.passwordConfirmLabel}
            value={p2}
            onChange={(v) => send({ type: 'p2', value: secret(v) })}
            onEnter={submit}
            placeholder={t.common.passwordConfirmPlaceholder}
            autoComplete="new-password"
            error={mismatch ? t.common.passwordsMismatch : null}
          />
        </FlowPage>
      )
    }
    case 'applying':
      return (
        <FlowPage title={title}>
          <Working label={t.protection.applying} />
        </FlowPage>
      )
    case 'done':
      return (
        <FlowPage title={title} onBack={close} backKind="close" footer={<PrimaryAction label={t.common.close} onClick={close} />}>
          <div className="flex flex-1 flex-col justify-center">
            <Hero icon={<CheckIcon />} tone="success" title={t.protection.doneTitle} body={f(t.protection.doneBody, { mode: t.protection.mode[s.target] })} />
          </div>
        </FlowPage>
      )
    case 'failed':
      return (
        <FlowPage title={title} onBack={close} backKind="close" footer={<PrimaryAction label={t.common.retry} onClick={() => send({ type: 'retry' })} />}>
          <Hero icon={<ShieldIcon />} tone="warning" title={t.protection.failedTitle} />
          <Callout tone="warning" role="alert">
            {s.partial ? t.protection.partial : s.reason === 'keystore' ? t.protection.failedKeystore : s.reason === 'head' ? t.protection.failedHead : t.protection.failedRewrap}
          </Callout>
        </FlowPage>
      )
    case 'exit':
      return null
  }
}
