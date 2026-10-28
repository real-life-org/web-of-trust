// The interop probe of the developer area (TRANSPORT.md "Interop probe"): one sealed envelope as a
// `sealed-envelope/0.1` document in the Trust Tasks TSP binding to the did:key of a foreign agent,
// through the build's mediator, without a contact; the agent's answer in the delivery line, the run's
// diagnoses (codes of the closed catalog) below it. Reachable
// only in a build whose port has a probe (a web build with VITE_INTEROP_PROBE=true).
import { useEffect, useId, useState } from 'react'
import { useInteropProbe } from '../../hooks'
import { useI18n } from '../../i18n'
import { FlowPage } from '../../ui/components'
import { Button, Input } from '../../ui/primitives'
import { deliveryWord } from '../chat/delivery-word'

export function InteropProbeScreen({ onBack }: { onBack: () => void }) {
  const i18n = useI18n()
  const x = i18n.t.interop
  const { probe, state } = useInteropProbe()
  const [did, setDid] = useState('')
  const inputId = useId()
  // leaving the page ends the probe: its wire closes
  useEffect(() => () => probe?.stop(), [probe])
  if (!probe) return <FlowPage title={x.title} onBack={onBack}><p className="m-0 px-4 text-sm">{x.unavailable}</p></FlowPage>
  const line =
    state.phase === 'invalid'
      ? x.invalid
      : state.phase === 'unreachable'
        ? x.unreachable
        : state.phase === 'running'
          ? deliveryWord(state.delivery, i18n)
          : null
  return (
    <FlowPage title={x.title} onBack={onBack}>
      <div className="flex flex-col gap-4 px-4 pb-6">
        <p className="m-0 text-sm text-pretty text-muted-foreground">{x.body}</p>
        <p className="m-0 text-xs break-all text-muted-foreground">{i18n.f(x.mediator, { did: probe.mediator })}</p>
        <form
          className="flex flex-col gap-2"
          onSubmit={(e) => {
            e.preventDefault()
            probe.send(did)
          }}
        >
          <label htmlFor={inputId} className="text-sm font-medium">
            {x.counterpart}
          </label>
          <Input id={inputId} value={did} onChange={(e) => setDid(e.target.value)} autoComplete="off" spellCheck={false} aria-invalid={state.phase === 'invalid'} />
          <Button type="submit" className="h-11 w-full" disabled={did.trim() === ''}>
            {x.send}
          </Button>
        </form>
        <p className="m-0 text-sm" role="status" aria-live="polite" data-testid="interop-line">
          {line ?? ''}
        </p>
        {state.phase === 'running' && state.mode !== null ? <p className="m-0 text-xs text-muted-foreground">{i18n.f(x.mode, { mode: state.mode })}</p> : null}
        {state.phase === 'running' && state.diagnostics.length > 0 ? (
          <section className="flex flex-col gap-1" aria-labelledby={`${inputId}-diagnostics`}>
            <h2 id={`${inputId}-diagnostics`} className="m-0 text-xs font-medium text-muted-foreground">
              {x.diagnostics}
            </h2>
            <ul className="m-0 list-none p-0 text-xs break-all text-muted-foreground" data-testid="interop-diagnostics">
              {state.diagnostics.map((d, k) => (
                <li key={k}>{d.detail !== undefined ? `${d.code} (${d.detail})` : d.code}</li>
              ))}
            </ul>
          </section>
        ) : null}
      </div>
    </FlowPage>
  )
}
