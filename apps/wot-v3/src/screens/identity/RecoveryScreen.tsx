// Recovery (architecture §4.2 "Wiederherstellen"): structure and copy of legacy RecoveryFlow.tsx,
// all BIP-39 lengths, the staged restore and the honest keys-only result (Identity §9.3).
import { useI18n } from '../../i18n'
import type { SetupEvent, SetupState } from '../../hooks'
import { useWordsEvent } from '../../hooks'
import {
  AlertIcon,
  Callout,
  CheckIcon,
  Field,
  FlowPage,
  Hero,
  KeyIcon,
  PrimaryAction,
  QuietAction,
  ShieldIcon,
  SurvivorList,
  Working,
} from '../../ui/components'
import { isProtectState, ProtectSteps } from './protect'
import { TermsSentence } from './OnboardingScreen'

export function RecoveryScreen({ state: s, send }: { state: SetupState; send: (e: SetupEvent) => void }) {
  const { t, f } = useI18n()
  const wordsEvent = useWordsEvent()
  const title = t.recovery.title
  const back = () => send({ type: 'back' })
  const cancel = () => send({ type: 'cancel' })

  if (isProtectState(s)) return <ProtectSteps state={s} send={send} title={title} />

  switch (s.name) {
    case 'enterWords': {
      const status =
        s.check === 'ok'
          ? t.recovery.checkOk
          : s.check === 'checksum'
            ? t.recovery.checkChecksum
            : s.check === 'unknown-word'
              ? t.recovery.checkUnknownWord
              : t.recovery.checkIncomplete
      const bad = s.check === 'checksum' || s.check === 'unknown-word'
      return (
        <FlowPage
          title={title}
          onBack={cancel}
          backKind="close"
          footer={
            <>
              <PrimaryAction label={t.common.next} onClick={() => send({ type: 'next' })} disabled={s.check !== 'ok'} />
              <QuietAction label={t.common.cancel} onClick={cancel} />
            </>
          }
        >
          <Hero icon={<KeyIcon />} title={t.recovery.title} body={t.recovery.subtitle} />
          <Field label={t.recovery.wordsLabel} error={bad ? status : null} hint={t.recovery.wordHint}>
            {(a) => (
              <div className="flex flex-col gap-1">
                <textarea
                  {...a}
                  value={s.text.reveal()}
                  rows={5}
                  autoFocus
                  autoComplete="off"
                  autoCorrect="off"
                  autoCapitalize="off"
                  spellCheck={false}
                  onChange={(e) => send(wordsEvent(e.target.value))}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && s.check === 'ok') {
                      e.preventDefault()
                      send({ type: 'next' })
                    }
                  }}
                  className="w-full resize-none rounded-lg border border-border bg-card px-4 py-3 font-mono text-sm leading-relaxed outline-none focus-visible:border-transparent focus-visible:ring-2 focus-visible:ring-ring aria-invalid:border-destructive"
                />
                <span aria-live="polite" className={s.check === 'ok' ? 'text-xs font-medium text-success' : 'text-xs text-muted-foreground'}>
                  {f(t.recovery.wordCount, { count: s.count })}
                  {s.check === 'ok' ? ` · ${t.recovery.checkOk}` : !bad && s.count > 0 ? ` · ${t.recovery.checkIncomplete}` : ''}
                </span>
              </div>
            )}
          </Field>
          <div className="flex flex-col gap-2 rounded-lg border border-border bg-card px-4 py-3.5">
            <h2 className="m-0 text-sm font-semibold">{t.recovery.whatHappensTitle}</h2>
            <ol className="m-0 flex list-decimal flex-col gap-1 pl-5 text-[13px] text-muted-foreground">
              <li>{t.recovery.whatHappens1}</li>
              <li>{t.recovery.whatHappens2}</li>
              <li>{t.recovery.whatHappens3}</li>
            </ol>
          </div>
        </FlowPage>
      )
    }
    case 'replaceWarning':
      return (
        <FlowPage
          title={title}
          onBack={back}
          footer={
            <>
              <PrimaryAction label={t.recovery.replaceButton} variant="destructive" onClick={() => send({ type: 'next' })} />
              <QuietAction label={t.common.cancel} onClick={cancel} />
            </>
          }
        >
          <Hero icon={<AlertIcon />} tone="warning" title={t.recovery.replaceTitle} />
          <Callout tone="warning">{t.recovery.replaceBody}</Callout>
        </FlowPage>
      )
    case 'terms':
      return (
        <FlowPage
          title={title}
          onBack={back}
          footer={
            <>
              <PrimaryAction label={t.common.next} onClick={() => send({ type: 'next' })} />
              <TermsSentence />
            </>
          }
        >
          <Hero icon={<ShieldIcon />} title={t.recovery.termsTitle} body={t.recovery.termsBody} />
        </FlowPage>
      )
    case 'staging':
    case 'switching':
      if (s.error)
        return (
          <FlowPage title={title} footer={<PrimaryAction label={t.common.retry} onClick={() => send({ type: 'retry' })} />}>
            <Hero icon={<AlertIcon />} tone="warning" title={t.recovery.errorTitle} />
            <Callout tone="warning" role="alert">
              {t.recovery.errorBody}
            </Callout>
          </FlowPage>
        )
      return (
        <FlowPage title={title}>
          <Working label={s.name === 'staging' ? t.recovery.staging : t.recovery.switching} />
        </FlowPage>
      )
    case 'wipingOld':
    case 'verifyingOld':
      return (
        <FlowPage title={title}>
          <Working label={s.name === 'wipingOld' ? t.recovery.wipingOld : t.recovery.verifyingOld} />
        </FlowPage>
      )
    case 'done':
      return (
        <FlowPage title={title} footer={<PrimaryAction label={t.onboarding.doneButton} onClick={() => send({ type: 'continue' })} />}>
          <div className="flex flex-1 flex-col justify-center gap-[18px]">
            <Hero icon={<CheckIcon />} tone="success" title={t.recovery.doneTitle} />
            <Callout tone="info">{t.recovery.keysOnly}</Callout>
            {s.oldSurvivors ? (
              <>
                <Callout tone="warning">{t.recovery.oldSurvivors}</Callout>
                <SurvivorList title={t.common.stillThere} items={s.oldSurvivors} />
              </>
            ) : null}
          </div>
        </FlowPage>
      )
    default:
      return null
  }
}
