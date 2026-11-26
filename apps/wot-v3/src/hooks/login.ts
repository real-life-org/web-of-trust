// Login into a web app (EXPERIMENTAL, flows/login.ts): the login machine with its effect runner (the
// answer through the port, the same-device return through the platform's browser) and the own name for
// the switch "send my name along".
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import type { AppPort, Result } from '../port'
import type { Platform } from '../platform/ports'
import type { EffectResult } from '../flows/machine'
import { loginMachine, loginStart, type LoginEffect, type LoginEvent, type LoginState } from '../flows/login'
import { createFlowRunner, type FlowRunner } from './flow-runner'
import { usePlatform, usePort } from './context'

export type { LoginState, LoginEvent, LoginFailure } from '../flows/login'

const fromResult = (r: Result<unknown>): EffectResult =>
  r.ok
    ? { ok: true, value: r.value }
    : { ok: false, code: r.error.kind === 'refused' ? r.error.code : r.error.kind === 'unavailable' && r.error.reason === 'not-supported' ? 'not-supported' : 'failed' }

/** what the app may share with a web app: the own profile's name and picture (null: none set) */
export interface OwnProfile {
  readonly name: string | null
  readonly picture: string | null
}
const NONE: OwnProfile = { name: null, picture: null }

export function loginExecutor(port: AppPort, platform: Pick<Platform, 'browser'>, ownProfile: () => OwnProfile) {
  return async (e: LoginEffect): Promise<EffectResult> => {
    switch (e.id) {
      case 'login.answer':
        try {
          const p = e.withProfile ? ownProfile() : NONE
          return fromResult(await port.trust.answerLogin(e.raw, { name: p.name, picture: p.picture }))
        } catch {
          return { ok: false, code: 'failed' }
        }
      case 'login.open':
        return { ok: (await platform.browser.open(e.url)) === 'opened' }
    }
  }
}

export interface LoginFlow {
  readonly state: LoginState
  readonly send: (e: LoginEvent) => void
}

/** `ownProfile`: name and picture, read when the answer is built. */
export function useLogin(raw: string, ownProfile: OwnProfile, onExit: () => void, override?: LoginState | null): LoginFlow {
  const port = usePort()
  const platform = usePlatform()
  const machine = useMemo(() => loginMachine(), [])
  const [first] = useState(() => loginStart(raw))
  const profileRef = useRef(ownProfile)
  useEffect(() => {
    profileRef.current = ownProfile
  })
  const [runner, setRunner] = useState<FlowRunner<LoginState, LoginEvent> | null>(null)
  useEffect(() => {
    if (override) return
    const r = createFlowRunner(machine, first, loginExecutor(port, platform, () => profileRef.current), platform)
    setRunner(r)
    return () => r.dispose()
    // the runner lives as long as the page that started the flow
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  const subscribe = runner ? runner.subscribe : noSubscribe
  const get = runner ? runner.get : () => override ?? first
  const state = useSyncExternalStore(subscribe, get, get)
  const exitRef = useRef(onExit)
  useEffect(() => {
    exitRef.current = onExit
  })
  useEffect(() => {
    if (state.name === 'exit') exitRef.current()
  }, [state])
  return { state, send: runner ? runner.send : noop }
}

const noSubscribe = () => () => {}
const noop = () => {}
