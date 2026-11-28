// @vitest-environment node
// Login into a web app (experimental) on the real adapter and the real library (0.21,
// KeyProvider.loginIdentity): the port's answerLogin signs with the identity the library derives for
// the web app's origin. Two devices with the same words answer with the same identifier (multi-device
// stage 1), two people and two origins with different ones. The web app is a fetch stand-in.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { virtualClock } from '../../src/platform/fake'
import { loginLink } from '../../src/lib/login-request'
import { LOOPBACK_PHRASES, loopbackDevice, memoryCarrier } from '../../harness/loopback'

const T0 = Date.parse('2026-11-25T10:00:00+01:00')

const request = (clientId = 'https://beispiel.org') =>
  loginLink(
    `openid://?${new URLSearchParams({ response_type: 'id_token', response_mode: 'direct_post', scope: 'openid', id_token_type: 'subject_signed', client_id: clientId, response_uri: `${clientId}/antwort`, nonce: 'n', state: 's' }).toString()}`,
  )

/** the iss of every token the stand-in web app received, in order */
function webApp() {
  const issuers: string[] = []
  vi.stubGlobal('fetch', async (_url: string, init: RequestInit) => {
    const token = new URLSearchParams(String(init.body)).get('id_token')!
    const claims = JSON.parse(Buffer.from(token.split('.')[1]!, 'base64url').toString('utf8')) as { iss: string; sub: string }
    issuers.push(claims.iss)
    return new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } })
  })
  return issuers
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('login on the real adapter', () => {
  it('one identifier per person and origin, the same on two devices with the same words', async () => {
    const carrier = memoryCarrier()
    const clock = virtualClock(T0, 'Europe/Berlin')
    const phone = await loopbackDevice({ carrier, id: 'P', name: 'Anton', words: LOOPBACK_PHRASES[0], clock, seed: 61 })
    const laptop = await loopbackDevice({ carrier, id: 'L', name: 'Anton', words: LOOPBACK_PHRASES[0], clock, seed: 63 })
    const other = await loopbackDevice({ carrier, id: 'O', name: 'Bea', words: LOOPBACK_PHRASES[1], clock, seed: 65 })
    const issuers = webApp()
    for (const [d, origin] of [[phone, 'https://beispiel.org'], [laptop, 'https://beispiel.org'], [other, 'https://beispiel.org'], [phone, 'https://andere.example']] as const) {
      expect(await d.port.trust.answerLogin(request(origin), { name: null })).toEqual({ ok: true, value: { kind: 'done' } })
    }
    const [p, l, o, elsewhere] = issuers
    expect(p).toMatch(/^did:key:z6Mk/)
    expect(l).toBe(p)
    expect(o).not.toBe(p)
    expect(elsewhere).not.toBe(p)
  })
})
