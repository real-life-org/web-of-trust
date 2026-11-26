// Login into a web app (EXPERIMENTAL, flows/login.ts): the web app by its address, the experimental
// note (the name the web app sees does not stay valid), the switch for the own name and picture (on
// by default, Anton 26.11.2026: the person confirms this very web app anyway), and the answer.
// A page in the content column, like the encounter (Anton 29.10.).
import { useState } from 'react'
import { useBackInFlow, useLogin, useProfile, type LoginEvent, type LoginState, type SharedProfile } from '../../hooks'
import { useI18n } from '../../i18n'
import { AlertIcon, Callout, CheckIcon, CheckRow, FlowPage, Hero, KeyIcon, OutlineAction, PersonAvatar, PrimaryAction, QuietAction, Working } from '../../ui/components'

export function LoginScreen({ raw, onExit }: { raw: string; onExit: () => void }) {
  const profile = useProfile()
  const own: SharedProfile = profile.status === 'ready' ? { name: profile.value?.name ?? null, picture: profile.value?.image ?? null } : { name: null, picture: null }
  const { state, send } = useLogin(raw, onExit)
  // system back is the flow's back (§4.1)
  useBackInFlow(() => send({ type: 'back' }))
  return <LoginView state={state} send={send} own={own} />
}

const NOTHING: SharedProfile = { name: null, picture: null }

/** The view of one machine state (also used by the screen catalog). */
export function LoginView({ state: s, send, own }: { state: LoginState; send: (e: LoginEvent) => void; own: SharedProfile }) {
  const { t, f } = useI18n()
  const l = t.login
  const [withProfile, setWithProfile] = useState(true)
  const hasProfile = Boolean(own.name || own.picture)
  // one source for preview and answer (review #557): before the confirmation what the switch selects,
  // after it what was confirmed and is sent, also on a retry
  const shown: SharedProfile =
    s.name === 'review' ? (withProfile ? own : NOTHING) : s.name === 'sending' || s.name === 'failed' ? s.shared : NOTHING
  const shares = shown.name !== null || shown.picture !== null
  // the label names what is shared: the confirmed values once confirmed, otherwise what the profile offers
  const of = shares ? shown : own
  const shareLabel = of.name && of.picture ? l.withProfile : of.name ? l.withName : l.withPicture
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
          <Hero icon={<KeyIcon />} title={f(l.ask, { host })} body={shares ? l.seesShared : l.sees} />
          <Callout tone="warning">
            <strong className="font-semibold">{l.experimental}. </strong>
            {f(l.experimentalNote, { host })}
          </Callout>
          {hasProfile ? (
            <>
              {/* the preview: what the web app sees, apart from the switch that decides it */}
              <section className="space-y-1.5" aria-label={f(l.withProfileHint, { host })}>
                <p className="px-1 text-xs text-muted-foreground">{f(l.withProfileHint, { host })}</p>
                <div className="flex items-center gap-3 rounded-lg border border-border bg-card px-4 py-3">
                  <PersonAvatar name={shares ? (shown.name ?? '?') : '?'} image={shares ? shown.picture : null} size={44} />
                  <span className="min-w-0 flex-1 text-sm">
                    {shares ? <span className="font-medium">{shown.name ?? l.pictureOnly}</span> : <span className="text-muted-foreground">{l.withoutProfileHint}</span>}
                  </span>
                </div>
              </section>
              <CheckRow label={shareLabel} checked={shares} onChange={s.name === 'review' ? setWithProfile : () => undefined} />
            </>
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
            <PrimaryAction label={l.confirm} busy={busy} disabled={busy} onClick={() => send({ type: 'confirm', shared: shown })} />
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
