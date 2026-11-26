// @vitest-environment node
// Login into a web app (experimental, flows/login.ts): every row of the login table, through the real
// effect runner (hooks/login.ts) with a port whose answers are scripted and the fake platform's browser.
import { describe, expect, it } from 'vitest'
import type { AppPort, LoginOutcome, Result } from '../../src/port'
import { createFakePlatform, virtualClock } from '../../src/platform/fake'
import { loginMachine, loginStart, LOGIN_TABLE, type LoginEvent, type LoginState } from '../../src/flows/login'
import { createFlowRunner, type FlowRunner } from '../../src/hooks/flow-runner'
import { loginExecutor } from '../../src/hooks/login'
import { loginLink } from '../../src/lib/login-request'
import { tableCoverage } from './world'

const cover = tableCoverage('login', LOGIN_TABLE)
const T0 = Date.parse('2026-11-25T10:00:00+01:00')

const request = (over: Record<string, string> = {}) =>
  loginLink(
    `openid://?${new URLSearchParams({ response_type: 'id_token', response_mode: 'direct_post', scope: 'openid', id_token_type: 'subject_signed', client_id: 'https://beispiel.org', response_uri: 'https://beispiel.org/antwort', nonce: 'n', state: 's', ...over }).toString()}`,
  )

function setup(answers: Result<LoginOutcome>[], raw = request(), ownName: string | null = 'Anton') {
  const asked: { raw: string; name: string | null | undefined }[] = []
  const port = {
    trust: {
      answerLogin: async (r: string, opts: { name?: string | null }) => {
        asked.push({ raw: r, name: opts.name })
        return answers.shift() ?? { ok: true, value: { kind: 'done' } }
      },
    },
  } as unknown as AppPort
  const platform = createFakePlatform({ clock: virtualClock(T0, 'Europe/Berlin') })
  const runner: FlowRunner<LoginState, LoginEvent> = cover.track(createFlowRunner(loginMachine(), loginStart(raw), loginExecutor(port, platform, () => ownName), platform))
  const until = async (name: LoginState['name']) => {
    for (let i = 0; i < 200; i++) {
      if (runner.get().name === name) return runner.get()
      await new Promise((r) => setTimeout(r, 2))
    }
    throw new Error(`login: expected ${name}, still ${runner.get().name}`)
  }
  return { runner, until, asked, browser: platform.browser }
}

describe('login flow', () => {
  it('an unsafe or unreadable request starts invalid; back leaves', async () => {
    const f = setup([], request({ response_uri: 'https://angreifer.example/fang' }))
    expect(f.runner.get()).toMatchObject({ name: 'invalid' })
    f.runner.send({ type: 'back' })
    await f.until('exit')
    expect(setup([], 'https://web-of-trust.de/c#card').runner.get().name).toBe('invalid')
  })

  it('review shows the address; back leaves without sending', async () => {
    const f = setup([])
    expect(f.runner.get()).toMatchObject({ name: 'review', target: { origin: 'https://beispiel.org', host: 'beispiel.org' } })
    f.runner.send({ type: 'back' })
    await f.until('exit')
    expect(f.asked).toEqual([])
  })

  it('confirm with the name: answered, done on the other device; done leaves', async () => {
    const f = setup([{ ok: true, value: { kind: 'done' } }])
    f.runner.send({ type: 'confirm', withName: true })
    expect(f.runner.get().name).toBe('sending')
    await f.until('done')
    expect(f.runner.get()).toMatchObject({ returned: 'none' })
    expect(f.asked).toEqual([{ raw: request(), name: 'Anton' }])
    f.runner.send({ type: 'done' })
    await f.until('exit')
  })

  it('without the name the answer carries none', async () => {
    const f = setup([{ ok: true, value: { kind: 'done' } }])
    f.runner.send({ type: 'confirm', withName: false })
    await f.until('done')
    expect(f.asked).toEqual([{ raw: request(), name: null }])
  })

  it('same device: the return address opens in the browser; if it cannot, done says so', async () => {
    const f = setup([{ ok: true, value: { kind: 'return', url: 'https://beispiel.org/fertig?response_code=c' } }])
    f.runner.send({ type: 'confirm', withName: false })
    await f.until('done')
    expect(f.runner.get()).toMatchObject({ returned: 'opened' })
    expect(f.browser.opened).toEqual(['https://beispiel.org/fertig?response_code=c'])
    const g = setup([{ ok: true, value: { kind: 'return', url: 'https://beispiel.org/fertig?response_code=d' } }])
    g.browser.available = false
    g.runner.send({ type: 'confirm', withName: false })
    await g.until('done')
    expect(g.runner.get()).toMatchObject({ returned: 'failed', url: 'https://beispiel.org/fertig?response_code=d' })
    // the person taps "back to beispiel.org": the same address again, now the browser opens it
    g.browser.available = true
    g.runner.send({ type: 'reopen' })
    expect(g.runner.get().name).toBe('returning')
    await g.until('done')
    expect(g.runner.get()).toMatchObject({ returned: 'opened' })
    expect(g.browser.opened).toEqual(['https://beispiel.org/fertig?response_code=d'])
  })

  it('without a return address there is nothing to reopen', async () => {
    const f = setup([{ ok: true, value: { kind: 'done' } }])
    f.runner.send({ type: 'confirm', withName: false })
    await f.until('done')
    f.runner.send({ type: 'reopen' })
    expect(f.runner.get()).toMatchObject({ name: 'done', returned: 'none' })
    expect(f.browser.opened).toEqual([])
  })

  it('a refusal shows its reason; retry answers again; back leaves', async () => {
    const f = setup([
      { ok: false, error: { kind: 'refused', code: 'login-unreachable' } },
      { ok: false, error: { kind: 'unavailable', reason: 'not-supported' } },
    ])
    f.runner.send({ type: 'confirm', withName: true })
    await f.until('failed')
    expect(f.runner.get()).toMatchObject({ code: 'login-unreachable', withName: true })
    f.runner.send({ type: 'retry' })
    await new Promise((r) => setTimeout(r, 5))
    await f.until('failed')
    expect(f.runner.get()).toMatchObject({ code: 'not-supported' })
    expect(f.asked.map((a) => a.name)).toEqual(['Anton', 'Anton'])
    f.runner.send({ type: 'back' })
    await f.until('exit')
  })
})
