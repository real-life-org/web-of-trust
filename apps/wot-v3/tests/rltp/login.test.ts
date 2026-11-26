// @vitest-environment node
// Login into a web app (experimental, adapters/rltp/login.ts): the answer to a SIOPv2-shaped request,
// signed with the identity the library derives for the web app's origin, posted without following a
// redirect. The KeyProvider here is a stand-in with a real Ed25519 key and the shape of the library's
// `loginIdentity` (0.21); a web app answers through a fetch stand-in.
import { describe, expect, it } from 'vitest'
import { answerLogin, type LoginKeys } from '../../src/adapters/rltp/login'
import { loginLink } from '../../src/lib/login-request'

const S = globalThis.crypto.subtle
// base58btc and base64url here, so the test does not import the library (only the adapter may)
const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'
function base58(bytes: Uint8Array): string {
  let n = 0n
  for (const b of bytes) n = n * 256n + BigInt(b)
  let out = ''
  while (n > 0n) {
    out = B58[Number(n % 58n)] + out
    n /= 58n
  }
  for (const b of bytes) {
    if (b !== 0) break
    out = '1' + out
  }
  return out
}
function fromBase58(s: string): Uint8Array {
  let n = 0n
  for (const c of s) n = n * 58n + BigInt(B58.indexOf(c))
  const out: number[] = []
  while (n > 0n) {
    out.unshift(Number(n % 256n))
    n /= 256n
  }
  return Uint8Array.from(out)
}
const fromB64u = (s: string): Uint8Array => Uint8Array.from(Buffer.from(s, 'base64url'))
/** the raw Ed25519 key of a did:key (multicodec 0xed01) */
const edRawOfDid = (did: string): Uint8Array => fromBase58(did.slice('did:key:z'.length)).slice(2)
const T0 = Date.UTC(2026, 10, 25, 9, 0, 0)

async function keys(): Promise<LoginKeys & { asked: string[] }> {
  const pair = (await S.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify'])) as CryptoKeyPair
  const raw = new Uint8Array(await S.exportKey('raw', pair.publicKey))
  const did = 'did:key:z' + base58(Uint8Array.from([0xed, 0x01, ...raw]))
  const asked: string[] = []
  return {
    asked,
    async loginIdentity(origin) {
      asked.push(origin)
      return Object.freeze({ did, sign: async (bytes: Uint8Array) => new Uint8Array(await S.sign('Ed25519', pair.privateKey, bytes as BufferSource)) })
    },
  }
}

const request = (over: Record<string, string> = {}) =>
  loginLink(
    `openid://?${new URLSearchParams({
      response_type: 'id_token',
      response_mode: 'direct_post',
      scope: 'openid',
      id_token_type: 'subject_signed',
      client_id: 'https://beispiel.org',
      response_uri: 'https://beispiel.org/anmeldung/antwort',
      nonce: 'n-1',
      state: 's-1',
      ...over,
    }).toString()}`,
  )

/** a web app: records what it got, answers as told */
function webApp(answer: () => Response | Promise<Response>) {
  const got: { url: string; init: RequestInit }[] = []
  const fetchFn = (async (url: string | URL | Request, init?: RequestInit) => {
    got.push({ url: String(url), init: init ?? {} })
    return answer()
  }) as typeof fetch
  return { got, fetch: fetchFn }
}

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

async function tokenOf(body: string) {
  const form = new URLSearchParams(body)
  const [h, p, s] = form.get('id_token')!.split('.') as [string, string, string]
  const header = JSON.parse(new TextDecoder().decode(fromB64u(h)))
  const claims = JSON.parse(new TextDecoder().decode(fromB64u(p)))
  const did: string = claims.iss
  const pubRaw = edRawOfDid(did)
  const pub = await S.importKey('raw', pubRaw as BufferSource, { name: 'Ed25519' }, false, ['verify'])
  const valid = await S.verify('Ed25519', pub, fromB64u(s) as BufferSource, new TextEncoder().encode(`${h}.${p}`))
  return { header, claims, valid, state: form.get('state') }
}

describe('answerLogin', () => {
  it('signs a self-issued ID token for the web app and posts it to the response_uri, without following redirects', async () => {
    const k = await keys()
    const app = webApp(() => json(200, {}))
    const r = await answerLogin(k, request(), { now: T0, fetch: app.fetch })
    expect(r).toEqual({ ok: true, value: { kind: 'done' } })
    expect(k.asked).toEqual(['https://beispiel.org'])
    expect(app.got).toHaveLength(1)
    expect(app.got[0]!.url).toBe('https://beispiel.org/anmeldung/antwort')
    expect(app.got[0]!.init.redirect).toBe('manual')
    const t = await tokenOf(String(app.got[0]!.init.body))
    expect(t.valid).toBe(true)
    expect(t.header).toEqual({ alg: 'EdDSA', typ: 'JWT', kid: `${t.claims.iss}#${t.claims.iss.slice(8)}` })
    expect(t.claims).toEqual({ iss: t.claims.iss, sub: t.claims.iss, aud: 'https://beispiel.org', nonce: 'n-1', iat: T0 / 1000, exp: T0 / 1000 + 300 })
    expect(t.state).toBe('s-1')
  })

  it('sends the own name only when it is given', async () => {
    const k = await keys()
    const app = webApp(() => json(200, {}))
    await answerLogin(k, request(), { now: T0, fetch: app.fetch, name: '  Anton ' })
    await answerLogin(k, request(), { now: T0, fetch: app.fetch, name: null })
    expect((await tokenOf(String(app.got[0]!.init.body))).claims.name).toBe('Anton')
    expect((await tokenOf(String(app.got[1]!.init.body))).claims.name).toBeUndefined()
  })

  it('same-device: a return address on the web app’s origin is handed back; one elsewhere is refused', async () => {
    const k = await keys()
    const ok = await answerLogin(k, request(), { now: T0, fetch: webApp(() => json(200, { redirect_uri: 'https://beispiel.org/fertig?response_code=c' })).fetch })
    expect(ok).toEqual({ ok: true, value: { kind: 'return', url: 'https://beispiel.org/fertig?response_code=c' } })
    const away = await answerLogin(k, request(), { now: T0, fetch: webApp(() => json(200, { redirect_uri: 'https://angreifer.example/fertig?response_code=c' })).fetch })
    expect(away).toEqual({ ok: false, error: { kind: 'refused', code: 'login-refused' } })
  })

  it('a redirect, a refusal and an unreachable web app each end as their own refusal', async () => {
    const k = await keys()
    const redirect = await answerLogin(k, request(), { now: T0, fetch: webApp(() => new Response(null, { status: 307, headers: { Location: 'https://angreifer.example/' } })).fetch })
    expect(redirect).toEqual({ ok: false, error: { kind: 'refused', code: 'login-unreachable' } })
    const refused = await answerLogin(k, request(), { now: T0, fetch: webApp(() => json(400, { error: 'invalid_request' })).fetch })
    expect(refused).toEqual({ ok: false, error: { kind: 'refused', code: 'login-refused' } })
    const down = await answerLogin(k, request(), { now: T0, fetch: webApp(() => Promise.reject(new TypeError('network'))).fetch })
    expect(down).toEqual({ ok: false, error: { kind: 'refused', code: 'login-unreachable' } })
  })

  it('an unsafe request is refused before any key is asked or anything is sent', async () => {
    const k = await keys()
    const app = webApp(() => json(200, {}))
    expect(await answerLogin(k, request({ response_uri: 'https://angreifer.example/fang' }), { now: T0, fetch: app.fetch })).toEqual({ ok: false, error: { kind: 'refused', code: 'login-invalid' } })
    expect(await answerLogin(k, 'https://web-of-trust.de/c#card', { now: T0, fetch: app.fetch })).toEqual({ ok: false, error: { kind: 'refused', code: 'login-invalid' } })
    expect(k.asked).toEqual([])
    expect(app.got).toEqual([])
  })

  it('a library without loginIdentity answers not-supported and sends nothing', async () => {
    const app = webApp(() => json(200, {}))
    expect(await answerLogin({}, request(), { now: T0, fetch: app.fetch })).toEqual({ ok: false, error: { kind: 'unavailable', reason: 'not-supported' } })
    expect(app.got).toEqual([])
  })

  it('the token never carries more than the claims above (no keys, no anchors)', async () => {
    const k = await keys()
    const app = webApp(() => json(200, {}))
    await answerLogin(k, request(), { now: T0, fetch: app.fetch, name: 'Anton' })
    const t = await tokenOf(String(app.got[0]!.init.body))
    expect(Object.keys(t.claims).sort()).toEqual(['aud', 'exp', 'iat', 'iss', 'name', 'nonce', 'sub'])
  })
})
