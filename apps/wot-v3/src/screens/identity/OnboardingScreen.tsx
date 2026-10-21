// Onboarding (architecture §4.2): structure and copy of legacy OnboardingFlow.tsx, look of the
// prototype. One screen per machine state; the screen holds no flow logic.
import { useRef, type ReactNode } from 'react'
import { secret, type SetupEvent, type SetupState } from '../../hooks'
import { useI18n } from '../../i18n'
import {
  Callout,
  CheckIcon,
  Checklist,
  CopyIcon,
  Field,
  FlowPage,
  Hero,
  KeyIcon,
  MnemonicGrid,
  NetworkIcon,
  OutlineAction,
  PrimaryAction,
  QuietAction,
  StepProgress,
  WordInput,
  Working,
  AlertIcon,
} from '../../ui/components'
import { TextLink } from '../../ui/primitives'
import { isProtectState, ProtectSteps } from './protect'

/** Content rules (architecture §10, Frage 10: text and place still open). */
export const TERMS_URL = 'https://web-of-trust.de/terms'

/** The content rules as one sentence under the button that creates the identity (Play UGC, paper §6:
 *  "Mit Weiter stimmst du den Nutzungsregeln zu", with a link); pressing it is the consent. */
export function TermsSentence() {
  const { t } = useI18n()
  return (
    <p className="m-0 text-center text-xs text-pretty text-muted-foreground">
      {t.onboarding.termsSentence}{' '}
      <TextLink href={TERMS_URL} target="_blank" rel="noreferrer">
        {t.onboarding.termsLink}
      </TextLink>
    </p>
  )
}

const STEP: Partial<Record<SetupState['name'], number>> = {
  showWords: 1,
  lastWarning: 1,
  verifyWords: 2,
  profile: 3,
  protect: 4,
  biometricOnlyExplain: 4,
  protectPassphrase: 4,
  keyBeforeVault: 4,
  writingVault: 4,
  keyAfterVault: 4,
  protectFailed: 4,
  initHolder: 4,
  activating: 4,
}

export interface OnboardingScreenProps {
  state: SetupState
  send: (e: SetupEvent) => void
  hint: 'setup-interrupted' | 'access-missing' | null
  /** an iOS screenshot was taken while words were visible */
  captured?: boolean
}

export function OnboardingScreen({ state: s, send, hint, captured }: OnboardingScreenProps) {
  const { t } = useI18n()
  const step = STEP[s.name]
  const labels = [t.onboarding.stepWords, t.onboarding.stepCheck, t.onboarding.stepProfile, t.onboarding.stepProtect]
  const progress = step ? <StepProgress current={step} total={4} labels={labels} /> : undefined
  const title = t.onboarding.flowTitle
  const back = () => send({ type: 'back' })

  if (isProtectState(s)) return <ProtectSteps state={s} send={send} title={title} progress={progress} />

  switch (s.name) {
    case 'welcome':
    case 'generating': {
      const busy = s.name === 'generating'
      return (
        <FlowPage
          title={t.app.name}
          footer={
            <>
              <PrimaryAction label={busy ? t.onboarding.generating : t.onboarding.generateButton} onClick={() => send({ type: 'create' })} busy={busy} />
              <p className="m-0 pt-1 text-center text-[13px] text-muted-foreground">{t.onboarding.importLead}</p>
              <OutlineAction label={t.onboarding.importButton} onClick={() => send({ type: 'import' })} disabled={busy} />
            </>
          }
        >
          <Hero icon={<NetworkIcon filled />} title={t.onboarding.welcomeTitle} body={t.onboarding.welcomeSubtitle} />
          {hint ? <Callout tone="warning">{hint === 'setup-interrupted' ? t.onboarding.hintSetupInterrupted : t.onboarding.hintAccessMissing}</Callout> : null}
          {s.name === 'welcome' && s.error ? (
            <Callout tone="danger" role="alert">
              {t.onboarding.errorGenerating}
            </Callout>
          ) : null}
          <div className="flex flex-col gap-2 rounded-lg border border-border bg-card px-4 py-3.5">
            <h2 className="m-0 text-sm font-semibold">{t.onboarding.whatHappensTitle}</h2>
            <ol className="m-0 flex list-decimal flex-col gap-1.5 pl-5 text-sm text-muted-foreground marker:text-muted-foreground">
              <li>{t.onboarding.whatHappens1}</li>
              <li>{t.onboarding.whatHappens2}</li>
              <li>{t.onboarding.whatHappens3}</li>
              <li>{t.onboarding.whatHappens4}</li>
            </ol>
          </div>
          <Callout tone="warning">
            <strong className="font-semibold">{t.onboarding.importantNoticeLabel}</strong> {t.onboarding.importantNoticeText}
          </Callout>
        </FlowPage>
      )
    }
    case 'showWords': {
      const words = s.words.reveal()
      const all = s.checklist.every(Boolean)
      return (
        <FlowPage title={title} onBack={back} progress={progress} footer={<PrimaryAction label={t.common.continue} onClick={() => send({ type: 'next' })} disabled={!all} />}>
          <Hero icon={<KeyIcon />} tone="warning" title={t.onboarding.magicWordsTitle} body={t.onboarding.magicWordsInstruction} />
          {captured ? (
            <Callout tone="danger" role="alert">
              {t.onboarding.screenshotWarning}
            </Callout>
          ) : null}
          <MnemonicGrid words={words} label={t.onboarding.wordsLabel} />
          <div className="flex flex-col gap-1.5">
            <OutlineAction
              icon={s.copy === 'copied' ? <CheckIcon /> : <CopyIcon />}
              label={s.copy === 'copied' ? t.onboarding.copied : t.onboarding.copyToClipboard}
              onClick={() => send({ type: 'copy' })}
            />
            {s.copy === 'failed' ? (
              <p role="alert" className="m-0 text-center text-[13px] text-destructive">
                {t.onboarding.copyFailed}
              </p>
            ) : (
              <p className="m-0 text-center text-xs text-muted-foreground">{t.onboarding.copyNote}</p>
            )}
          </div>
          <Checklist
            title={t.onboarding.checklistTitle}
            items={[
              { label: t.onboarding.checklistWritten, checked: s.checklist[0] },
              { label: t.onboarding.checklistSafe, checked: s.checklist[1] },
              { label: t.onboarding.checklistUnderstand, checked: s.checklist[2] },
            ]}
            onToggle={(i) => send({ type: 'toggle', index: i as 0 | 1 | 2 })}
          />
        </FlowPage>
      )
    }
    case 'lastWarning':
      return (
        <FlowPage
          title={title}
          onBack={back}
          progress={progress}
          footer={
            <>
              <PrimaryAction label={t.onboarding.lastWarningButton} onClick={() => send({ type: 'next' })} />
              <QuietAction label={t.onboarding.backToMagicWords} onClick={back} />
            </>
          }
        >
          <Hero icon={<AlertIcon />} tone="danger" title={t.onboarding.lastWarningTitle} />
          <Callout tone="danger">{t.onboarding.lastWarningText}</Callout>
        </FlowPage>
      )
    case 'verifyWords':
      return <VerifyStep state={s} send={send} title={title} progress={progress} />
    case 'profile': {
      const ready = s.displayName.trim() !== ''
      return (
        <FlowPage
          title={title}
          onBack={back}
          progress={progress}
          footer={
            <>
              <PrimaryAction label={t.common.next} onClick={() => send({ type: 'next' })} disabled={!ready} />
              <TermsSentence />
            </>
          }
        >
          <Hero icon={<CheckIcon />} title={t.onboarding.profileTitle} body={t.onboarding.profileSubtitle} />
          <Field label={t.onboarding.profileNameLabel}>
            {(a) => (
              <input
                {...a}
                type="text"
                value={s.displayName}
                placeholder={t.onboarding.profileNamePlaceholder}
                autoComplete="name"
                autoFocus
                maxLength={80}
                onChange={(e) => send({ type: 'name', value: e.target.value })}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && ready) send({ type: 'next' })
                }}
                className="h-11 w-full rounded-lg border border-border bg-card px-4 text-[15px] outline-none focus-visible:border-transparent focus-visible:ring-2 focus-visible:ring-ring"
              />
            )}
          </Field>
        </FlowPage>
      )
    }
    case 'initHolder':
    case 'activating':
      if (s.error)
        return (
          <FlowPage title={title} progress={progress} footer={<PrimaryAction label={t.common.retry} onClick={() => send({ type: 'retry' })} />}>
            <Hero icon={<AlertIcon />} tone="warning" title={t.onboarding.initErrorTitle} />
            <Callout tone="warning" role="alert">
              {t.onboarding.initErrorBody}
            </Callout>
          </FlowPage>
        )
      return (
        <FlowPage title={title} progress={progress}>
          <Working label={s.name === 'initHolder' ? t.protect.init : t.protect.activate} />
        </FlowPage>
      )
    case 'done':
      return (
        <FlowPage title={t.onboarding.done} footer={<PrimaryAction label={t.onboarding.doneButton} onClick={() => send({ type: 'continue' })} />}>
          <div className="flex flex-1 flex-col justify-center">
            <Hero icon={<CheckIcon />} tone="success" title={t.onboarding.doneTitle} body={t.onboarding.doneBody} />
          </div>
        </FlowPage>
      )
    default:
      return null
  }
}

/** Three positions, Enter moves to the next field and submits from the last (legacy). */
function VerifyStep({ state: s, send, title, progress }: { state: Extract<SetupState, { name: 'verifyWords' }>; send: (e: SetupEvent) => void; title: string; progress: ReactNode }) {
  const { t, f } = useI18n()
  const refs = useRef<(HTMLInputElement | null)[]>([])
  const values = s.positions.map((_, i) => s.inputs[i]?.reveal() ?? '')
  const complete = values.every((v) => v.trim() !== '')
  const check = () => complete && send({ type: 'check' })
  return (
    <FlowPage
      title={title}
      onBack={() => send({ type: 'back' })}
      progress={progress}
      footer={
        <>
          <PrimaryAction label={t.onboarding.verifyButton} onClick={check} disabled={!complete} />
          <QuietAction label={t.onboarding.backToMagicWords} onClick={() => send({ type: 'back' })} />
        </>
      }
    >
      <Hero icon={<CheckIcon />} title={t.onboarding.verifyTitle} body={t.onboarding.verifyInstruction} />
      {s.positions.map((pos, i) => (
        <WordInput
          key={pos}
          inputRef={(el) => {
            refs.current[i] = el
          }}
          label={f(t.onboarding.wordLabel, { number: pos + 1 })}
          value={values[i] ?? ''}
          placeholder={t.onboarding.wordPlaceholder}
          autoFocus={i === 0}
          error={s.wrong.includes(i) ? f(t.onboarding.wordWrong, { number: pos + 1 }) : null}
          onChange={(v) => send({ type: 'input', index: i, value: secret(v) })}
          onEnter={() => (i < s.positions.length - 1 ? refs.current[i + 1]?.focus() : check())}
        />
      ))}
      {s.wrong.length > 0 ? (
        <Callout tone="danger" role="alert">
          {t.onboarding.errorVerifyMismatch}
        </Callout>
      ) : null}
    </FlowPage>
  )
}
