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

export function loginExecutor(port: AppPort, platform: Pick<Platform, 'browser'>, ownName: () => string | null) {
  return async (e: LoginEffect): Promise<EffectResult> => {
    switch (e.id) {
      case 'login.answer':
        try {
          return fromResult(await port.trust.answerLogin(e.raw, { name: e.withName ? ownName() : null }))
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

/** `ownName`: the profile's name, read when the answer is built (null: none set). */
export function useLogin(raw: string, ownName: string | null, onExit: () => void, override?: LoginState | null): LoginFlow {
  const port = usePort()
  const platform = usePlatform()
  const machine = useMemo(() => loginMachine(), [])
  const [first] = useState(() => loginStart(raw))
  const nameRef = useRef(ownName)
  useEffect(() => {
    nameRef.current = ownName
  })
  const [runner, setRunner] = useState<FlowRunner<LoginState, LoginEvent> | null>(null)
  useEffect(() => {
    if (override) return
    const r = createFlowRunner(machine, first, loginExecutor(port, platform, () => nameRef.current), platform)
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
