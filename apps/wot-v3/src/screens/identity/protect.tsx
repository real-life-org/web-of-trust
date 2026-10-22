// The protection steps shared by onboarding and recovery (architecture §4.2: protect,
// biometricOnlyExplain, protectPassphrase, keyBeforeVault, writingVault, keyAfterVault, protectFailed).
import type { ReactNode } from 'react'
import { MIN_PASSPHRASE, secret, type SetupEvent, type SetupState } from '../../hooks'
import { useI18n } from '../../i18n'
import {
  CheckRow,
  ChoiceCard,
  Callout,
  FingerprintIcon,
  FlowPage,
  Hero,
  KeyIcon,
  PassphraseInput,
  PrimaryAction,
  ShieldIcon,
  Working,
} from '../../ui/components'

type S = SetupState
type Send = (e: SetupEvent) => void

export const PROTECT_STATES = ['protect', 'biometricOnlyExplain', 'protectPassphrase', 'keyBeforeVault', 'writingVault', 'keyAfterVault', 'protectFailed'] as const

export function isProtectState(s: S): boolean {
  return (PROTECT_STATES as readonly string[]).includes(s.name)
}

/** Renders the protection steps; `title` and `progress` are the frame of the calling flow. */
export function ProtectSteps({ state: s, send, title, progress }: { state: S; send: Send; title: string; progress?: ReactNode }) {
  const { t, f } = useI18n()
  const back = () => send({ type: 'back' })
  switch (s.name) {
    case 'protect': {
      const kind = s.available !== null && s.available !== 'probing' ? t.biometricKind[s.available] : null
      return (
        <FlowPage title={title} onBack={back} progress={progress}>
          <Hero icon={<ShieldIcon />} tone="success" title={t.protect.title} body={t.protect.subtitle} />
          <div className="flex flex-col gap-2.5">
            <ChoiceCard
              icon={<FingerprintIcon />}
              title={t.protect.biometricOption}
              sub={kind ? f(t.protect.biometricOptionSub, { kind }) : s.available === 'probing' ? t.protect.probing : t.protect.biometricUnavailable}
              onClick={() => send({ type: 'chooseBiometric' })}
              disabled={kind === null}
            />
            <ChoiceCard icon={<KeyIcon />} title={t.protect.passphraseOption} sub={t.protect.passphraseOptionSub} onClick={() => send({ type: 'choosePassphrase' })} />
          </div>
        </FlowPage>
      )
    }
    case 'biometricOnlyExplain':
      return (
        <FlowPage title={title} onBack={back} progress={progress} footer={<PrimaryAction label={t.protect.biometricOnlyConfirm} onClick={() => send({ type: 'confirm' })} />}>
          <Hero icon={<FingerprintIcon />} title={t.protect.biometricOnlyTitle} />
          <Callout tone="warning">{t.protect.biometricOnlyBody}</Callout>
        </FlowPage>
      )
    case 'protectPassphrase': {
      const p1 = s.p1.reveal()
      const p2 = s.p2.reveal()
      const tooShort = p1.length > 0 && p1.length < MIN_PASSPHRASE
      // live mismatch hint only once both fields are filled (legacy cf51557d)
      const mismatch = p1.length > 0 && p2.length > 0 && p1 !== p2
      const ready = p1.length >= MIN_PASSPHRASE && p1 === p2
      const submit = () => ready && send({ type: 'next' })
      const canBio = s.available !== null && s.available !== 'probing'
      return (
        <FlowPage title={title} onBack={back} progress={progress} footer={<PrimaryAction label={t.protect.protectButton} onClick={submit} disabled={!ready} />}>
          <Hero icon={<KeyIcon />} tone="success" title={t.protect.passphraseTitle} body={t.protect.passphraseSubtitle} />
          <Callout tone="info">
            <strong className="font-semibold">{t.protect.tipLabel}</strong> {t.protect.tipText}
          </Callout>
          <PassphraseInput
            label={t.common.passwordLabel}
            value={p1}
            onChange={(v) => send({ type: 'p1', value: secret(v) })}
            onEnter={submit}
            placeholder={t.common.passwordPlaceholder}
            autoComplete="new-password"
            autoFocus
            hint={tooShort ? t.common.passwordMinLength : undefined}
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
          {canBio ? (
            <div className="rounded-lg border border-border bg-card">
              <CheckRow label={t.protect.addBiometric} hint={t.protect.addBiometricSub} checked={s.addBiometric} onChange={(v) => send({ type: 'addBiometric', value: v })} />
            </div>
          ) : null}
        </FlowPage>
      )
    }
    case 'keyBeforeVault':
      return (
        <FlowPage title={title} progress={progress}>
          <Working label={t.protect.keystore} />
        </FlowPage>
      )
    case 'writingVault':
      return (
        <FlowPage title={title} progress={progress}>
          <Working label={t.protect.vault} />
        </FlowPage>
      )
    case 'keyAfterVault':
      return (
        <FlowPage title={title} progress={progress}>
          <Working label={t.protect.keystore} />
        </FlowPage>
      )
    case 'protectFailed':
      return (
        <FlowPage title={title} onBack={back} progress={progress} footer={<PrimaryAction label={t.protect.chooseAgain} onClick={() => send({ type: 'retry' })} />}>
          <Hero icon={<ShieldIcon />} tone="warning" title={t.protect.failedTitle} />
          <Callout tone="warning" role="alert">
            {s.reason === 'keystore' ? t.protect.failedKeystore : t.protect.failedVault}
          </Callout>
          {s.orphan ? <Callout tone="info">{t.protect.failedOrphan}</Callout> : null}
        </FlowPage>
      )
    default:
      return null
  }
}
