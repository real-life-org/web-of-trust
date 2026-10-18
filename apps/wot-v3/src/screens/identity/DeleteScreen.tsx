// Delete the identity (architecture §4.2 "Identität löschen"): fail-closed like legacy Identity.tsx
// (error stays visible, 14dc3649), named "Delete identity" instead of "Log out" (DA §3), typed
// confirmation, phases visible, local and remote result separate.
import type { DeleteEvent, DeleteState } from '../../hooks'
import { useI18n } from '../../i18n'
import { Callout, CheckIcon, Field, FlowPage, Hero, PhaseList, PrimaryAction, QuietAction, SurvivorList, TrashIcon, AlertIcon } from '../../ui/components'

const PHASES = ['quiescing', 'deregistering', 'sealing', 'closing', 'wiping', 'verifying'] as const

export function DeleteScreen({ state: s, send }: { state: DeleteState; send: (e: DeleteEvent) => void }) {
  const { t, f } = useI18n()
  const title = t.deleteIdentity.title
  const phases = PHASES.map((id) => ({ id, label: t.deleteIdentity[id] }))
  switch (s.name) {
    case 'explain':
      return (
        <FlowPage title={title} onBack={() => send({ type: 'back' })} backKind="close" footer={<PrimaryAction label={t.deleteIdentity.explainNext} variant="destructive" onClick={() => send({ type: 'next' })} />}>
          <Hero icon={<TrashIcon />} tone="danger" title={t.deleteIdentity.explainTitle} body={t.deleteIdentity.explainBody} />
          <Callout tone="warning">{t.deleteIdentity.explainWarning}</Callout>
        </FlowPage>
      )
    case 'confirm': {
      const ok = s.typed.trim().toLocaleLowerCase() === s.word.toLocaleLowerCase()
      return (
        <FlowPage
          title={title}
          onBack={() => send({ type: 'back' })}
          footer={<PrimaryAction label={t.deleteIdentity.confirmButton} variant="destructive" onClick={() => send({ type: 'confirm' })} disabled={!ok} />}
        >
          <Hero icon={<TrashIcon />} tone="danger" title={f(t.deleteIdentity.confirmTitle, { word: s.word })} />
          <Field label={t.deleteIdentity.confirmLabel}>
            {(a) => (
              <input
                {...a}
                type="text"
                value={s.typed}
                autoFocus
                autoComplete="off"
                autoCapitalize="characters"
                spellCheck={false}
                onChange={(e) => send({ type: 'typed', value: e.target.value })}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && ok) send({ type: 'confirm' })
                }}
                className="h-11 w-full rounded-lg border border-border bg-card px-4 font-mono text-[15px] tracking-wide outline-none focus-visible:border-transparent focus-visible:ring-2 focus-visible:ring-ring"
              />
            )}
          </Field>
        </FlowPage>
      )
    }
    case 'quiescing':
    case 'deregistering':
    case 'sealing':
    case 'closing':
    case 'wiping':
    case 'verifying':
      return (
        <FlowPage title={title}>
          <Hero icon={<TrashIcon />} tone="danger" title={t.deleteIdentity.title} />
          <PhaseList phases={phases} current={s.name} />
        </FlowPage>
      )
    case 'done': {
      const r = s.report.remote
      const total = r.done + r.pending + r.failed
      return (
        <FlowPage title={title} footer={<PrimaryAction label={t.deleteIdentity.doneButton} onClick={() => send({ type: 'continue' })} />}>
          <div className="flex flex-1 flex-col justify-center gap-[18px]">
            <Hero icon={<CheckIcon />} tone="success" title={t.deleteIdentity.doneTitle} />
            <Callout tone={r.failed > 0 || r.pending > 0 ? 'warning' : 'info'} role="status">
              {total === 0 ? t.deleteIdentity.remoteNone : f(t.deleteIdentity.remote, { done: r.done, pending: r.pending, failed: r.failed })}
            </Callout>
          </div>
        </FlowPage>
      )
    }
    case 'failed':
      return (
        <FlowPage title={title} footer={<PrimaryAction label={t.common.retry} onClick={() => send({ type: 'retry' })} />}>
          <Hero icon={<AlertIcon />} tone="danger" title={t.deleteIdentity.failedTitle} />
          <Callout tone="danger" role="alert">
            {t.deleteIdentity.failedBody}
          </Callout>
          <SurvivorList title={t.common.stillThere} items={s.survivors} />
        </FlowPage>
      )
    case 'resumeChoice':
      return (
        <FlowPage
          title={title}
          footer={
            <>
              {s.lock && !s.lock.unsupported && !s.lock.biometricLost ? (
                <PrimaryAction label={t.deleteIdentity.resumeUnlock} onClick={() => send({ type: 'unlockToDeregister' })} />
              ) : null}
              <QuietAction label={t.deleteIdentity.resumeSkip} onClick={() => send({ type: 'deleteWithoutDeregistration' })} />
            </>
          }
        >
          <Hero icon={<TrashIcon />} tone="warning" title={t.deleteIdentity.resumeTitle} body={t.deleteIdentity.resumeBody} />
        </FlowPage>
      )
    case 'exit':
      return null
  }
}
