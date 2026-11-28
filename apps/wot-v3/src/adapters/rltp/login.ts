// Login into a web app (EXPERIMENTAL, library deviation D6, trust-protocol#211): the answer to a
// SIOPv2-shaped request. The identity toward the web app comes from the library's KeyProvider
// (`loginIdentity(origin)`, one did:key per origin, the key stays inside the library; architecture
// §5.1: the app derives nothing itself). The self-issued ID token (iss = sub = that did:key, aud = the
// web app, the request's nonce, iat/exp, optionally the own name) is a compact JWS with EdDSA, posted
// to the response_uri as form data. A redirect is never followed: the signed token goes only to the
// origin the person confirmed. For a same-device request the web app names a return address, opened
// only on its own origin. Prototype and reviews: port-experimente `src/lab/anmeldung/` (#128, #131).
import { b64uOf } from '@real-life/trust-protocol'
import type { LoginOutcome, Result } from '../../port'
import { loginTarget, mayReturnTo, readLoginRequest } from '../../lib/login-request'

/** what the login needs of the KeyProvider (optional there: libraries before 0.21 lack it) */
export interface LoginKeys {
  loginIdentity?(origin: string): Promise<{ did: string; sign: (bytes: Uint8Array) => Promise<Uint8Array> }>
}

export const TOKEN_LIFETIME_S = 300

const te = new TextEncoder()
const b64uJson = (o: unknown): string => b64uOf(te.encode(JSON.stringify(o)))
const refused = (code: 'login-invalid' | 'login-refused' | 'login-unreachable'): Result<never> => ({ ok: false, error: { kind: 'refused', code } })
const PICTURE = /^data:image\/(webp|png|jpeg);base64,[A-Za-z0-9+/]+=*$/
const NOT_SUPPORTED = { ok: false, error: { kind: 'unavailable', reason: 'not-supported' } } as const

export async function answerLogin(
  keys: LoginKeys,
  raw: string,
  opts: { name?: string | null; picture?: string | null; now: number; fetch?: typeof fetch },
): Promise<Result<LoginOutcome>> {
  const request = readLoginRequest(raw)
  const target = request ? loginTarget(request) : null
  if (!request || !target) return refused('login-invalid')
  if (typeof keys.loginIdentity !== 'function') return NOT_SUPPORTED
  const id = await keys.loginIdentity(target.origin)
  const iat = Math.floor(opts.now / 1000)
  const name = typeof opts.name === 'string' && opts.name.trim() !== '' ? opts.name.trim() : null
  // the profile picture only as the inline image the app keeps (lib/avatar), never a URL
  const picture = typeof opts.picture === 'string' && PICTURE.test(opts.picture) ? opts.picture : null
  const claims = { iss: id.did, sub: id.did, aud: request.client_id, nonce: request.nonce, iat, exp: iat + TOKEN_LIFETIME_S, ...(name ? { name } : {}), ...(picture ? { picture } : {}) }
  const input = `${b64uJson({ alg: 'EdDSA', typ: 'JWT', kid: `${id.did}#${id.did.slice('did:key:'.length)}` })}.${b64uJson(claims)}`
  const token = `${input}.${b64uOf(await id.sign(te.encode(input)))}`
  let res: Response
  try {
    res = await (opts.fetch ?? fetch)(request.response_uri, {
      method: 'POST',
      redirect: 'manual',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ id_token: token, state: request.state }).toString(),
    })
  } catch {
    return refused('login-unreachable')
  }
  // a redirect (or the browser's opaque form of it) is not followed: the token stays with the origin confirmed
  if (res.type === 'opaqueredirect' || (res.status >= 300 && res.status < 400)) return refused('login-unreachable')
  if (!res.ok) return refused('login-refused')
  const body = (await res.json().catch(() => ({}))) as { redirect_uri?: unknown }
  if (typeof body.redirect_uri === 'string') {
    return mayReturnTo(request, body.redirect_uri) ? { ok: true, value: { kind: 'return', url: body.redirect_uri } } : refused('login-refused')
  }
  return { ok: true, value: { kind: 'done' } }
}
