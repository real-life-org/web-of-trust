// Login into a web app (EXPERIMENTAL, flows/login.ts): the web app by its address, the experimental
// note (the name the web app sees does not stay valid), the switch for the own name, and the answer.
// A page in the content column, like the encounter (Anton 29.10.).
import { useState } from 'react'
import { useBackInFlow, useLogin, useProfile, type LoginEvent, type LoginState } from '../../hooks'
import { useI18n } from '../../i18n'
import { AlertIcon, Callout, CheckIcon, CheckRow, FlowPage, Hero, KeyIcon, OutlineAction, PrimaryAction, QuietAction, Working } from '../../ui/components'

export function LoginScreen({ raw, onExit }: { raw: string; onExit: () => void }) {
  const profile = useProfile()
  const ownName = profile.status === 'ready' ? (profile.value?.name ?? null) : null
  const { state, send } = useLogin(raw, ownName, onExit)
  // system back is the flow's back (§4.1)
  useBackInFlow(() => send({ type: 'back' }))
  return <LoginView state={state} send={send} ownName={ownName} />
}

/** The view of one machine state (also used by the screen catalog). */
export function LoginView({ state: s, send, ownName }: { state: LoginState; send: (e: LoginEvent) => void; ownName: string | null }) {
  const { t, f } = useI18n()
  const l = t.login
  const [withName, setWithName] = useState(false)
  const back = () => send({ type: 'back' })
  const page = (children: React.ReactNode, footer?: React.ReactNode, backKind: 'back' | 'close' = 'close') => (
    <FlowPage title={l.title} onBack={back} backKind={backKind} footer={footer}>
      {children}
    </FlowPage>
  )
  switch (s.name) {
    case 'invalid':
      return page(<Hero icon={<AlertIcon />} tone="warning" title={l.invalidTitle} body={l.invalid} />)
    case 'review':
    case 'sending':
    case 'failed': {
      const host = s.target.host
      const busy = s.name === 'sending'
      return page(
        <>
          <Hero icon={<KeyIcon />} title={f(l.ask, { host })} body={l.sees} />
          <Callout tone="warning">
            <strong className="font-semibold">{l.experimental}. </strong>
            {f(l.experimentalNote, { host })}
          </Callout>
          {ownName ? (
            <div className="rounded-lg border border-border">
              <CheckRow label={l.withName} checked={s.name === 'review' ? withName : s.withName} onChange={s.name === 'review' ? setWithName : () => undefined} hint={f(l.withNameHint, { host, name: ownName })} />
            </div>
          ) : null}
          {s.name === 'failed' ? (
            <Callout tone="danger" role="alert">
              {f(l[`error.${s.code}`], { host })}
            </Callout>
          ) : null}
          {busy ? <Working label={l.sending} /> : null}
        </>,
        <>
          {s.name === 'failed' ? (
            <PrimaryAction label={t.common.retry} onClick={() => send({ type: 'retry' })} />
          ) : (
            <PrimaryAction label={l.confirm} busy={busy} disabled={busy} onClick={() => send({ type: 'confirm', withName: Boolean(ownName) && withName })} />
          )}
          <QuietAction label={t.common.cancel} disabled={busy} onClick={back} />
        </>,
      )
    }
    case 'returning':
      return page(<Working label={l.sending} />)
    case 'done': {
      const host = s.target.host
      const text = s.returned === 'opened' ? l.doneOpened : s.returned === 'failed' ? l.doneOpenFailed : l.doneOther
      // same-device: the way back stays on the page as a tap of the person's own (a blocked tab, a
      // browser that did not come to the front)
      const footer = (
        <>
          {s.url ? <OutlineAction label={f(l.backTo, { host })} onClick={() => send({ type: 'reopen' })} /> : null}
          <PrimaryAction label={l.done} onClick={() => send({ type: 'done' })} />
        </>
      )
      return page(<Hero icon={<CheckIcon />} tone="success" title={l.doneTitle} body={f(text, { host })} />, footer)
    }
    case 'exit':
      return null
  }
}
