// Gen-2 reset notice (legacy LegacyResetNotice.tsx, Anton: new identity with a notice). Full page
// instead of a modal over an empty app: it is the first thing a Gen-2 user sees in v3.
import type { LegacyEvent, LegacyState } from '../../hooks'
import { useI18n } from '../../i18n'
import { AlertIcon, Callout, FlowPage, Hero, PrimaryAction, SurvivorList, Working } from '../../ui/components'

export function LegacyResetScreen({ state: s, send }: { state: LegacyState; send: (e: LegacyEvent) => void }) {
  const { t } = useI18n()
  switch (s.name) {
    case 'notice':
      return (
        <FlowPage title={t.app.name} footer={<PrimaryAction label={t.legacyReset.dismiss} onClick={() => send({ type: 'acknowledge' })} />}>
          <div className="flex flex-1 flex-col justify-center">
            <Hero icon={<AlertIcon />} tone="warning" title={t.legacyReset.title} body={t.legacyReset.body} />
          </div>
        </FlowPage>
      )
    case 'wiping':
    case 'verifying':
    case 'marking':
      return (
        <FlowPage title={t.app.name}>
          <Working label={t.legacyReset.wiping} />
        </FlowPage>
      )
    case 'failed':
      return (
        <FlowPage title={t.app.name} footer={<PrimaryAction label={t.common.retry} onClick={() => send({ type: 'retry' })} />}>
          <Hero icon={<AlertIcon />} tone="danger" title={t.legacyReset.failedTitle} />
          <Callout tone="danger" role="alert">
            {t.legacyReset.failedBody}
          </Callout>
          <SurvivorList title={t.common.stillThere} items={s.survivors} />
        </FlowPage>
      )
    case 'exit':
      return null
  }
}
