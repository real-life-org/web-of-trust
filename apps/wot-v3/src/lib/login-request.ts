// Login into a web app (EXPERIMENTAL, library deviation D6, trust-protocol#211): the request a web app
// shows, in the shape of Self-Issued OpenID Provider v2 (request by value, `response_mode=direct_post`).
// Prototype and its reviews: port-experimente `src/lab/anmeldung/` (#128, #131).
//
// Pure, no imports: the flow decides with it, the adapters answer with it. Two forms reach the app:
// - the app link `https://web-of-trust.de/a#<the openid:// request, URI-encoded>`, which opens the app
//   (AndroidManifest, AASA) and which the app's own scanner reads;
// - the bare `openid://?…` request, which the app's own scanner reads (a web app that speaks SIOPv2
//   on its own shows that form; the operating system does not hand it to this app).

export const LOGIN_LINK_ORIGIN = 'https://web-of-trust.de'
export const LOGIN_LINK_PATH = '/a'
const SCHEME = 'openid://'

/** What a web app asks for. Field names as in SIOPv2. */
export interface LoginRequest {
  readonly response_type: 'id_token'
  readonly response_mode: 'direct_post'
  readonly scope: 'openid'
  readonly id_token_type: 'subject_signed'
  /** the web app, as a URL (client_id scheme redirect_uri) */
  readonly client_id: string
  /** where the answer goes; same origin as client_id */
  readonly response_uri: string
  readonly nonce: string
  readonly state: string
  /** self-asserted by the web app; never shown in place of the address */
  readonly client_name?: string
}

/** The web app as the person sees it: its origin and the host shown on the confirmation page. */
export interface LoginTarget {
  readonly origin: string
  readonly host: string
}

/** The origin of an https or http URL, or null. */
export function originOf(url: string): string | null {
  try {
    const u = new URL(url)
    return u.protocol === 'https:' || u.protocol === 'http:' ? u.origin : null
  } catch {
    return null
  }
}

/** The openid:// request inside a raw text (an app link or the bare request), or null. */
function requestText(raw: string): string | null {
  const text = raw.trim()
  if (text.startsWith(SCHEME)) return text
  let u: URL
  try {
    u = new URL(text)
  } catch {
    return null
  }
  if (u.origin !== LOGIN_LINK_ORIGIN || !/^\/a\/?$/.test(u.pathname) || u.hash.length < 2) return null
  try {
    const inner = decodeURIComponent(u.hash.slice(1))
    return inner.startsWith(SCHEME) ? inner : null
  } catch {
    return null
  }
}

/** Read a login request. Null for anything that is not a complete SIOPv2 request of this shape. */
export function readLoginRequest(raw: string): LoginRequest | null {
  if (typeof raw !== 'string') return null
  const text = requestText(raw)
  if (text === null) return null
  const q = new URLSearchParams(text.slice(text.indexOf('?') + 1))
  if (q.get('response_type') !== 'id_token' || q.get('response_mode') !== 'direct_post' || q.get('scope') !== 'openid' || q.get('id_token_type') !== 'subject_signed') return null
  const client_id = q.get('client_id'), response_uri = q.get('response_uri'), nonce = q.get('nonce'), state = q.get('state')
  if (!client_id || !response_uri || !nonce || !state) return null
  const name = q.get('client_name')
  return { response_type: 'id_token', response_mode: 'direct_post', scope: 'openid', id_token_type: 'subject_signed', client_id, response_uri, nonce, state, ...(name ? { client_name: name } : {}) }
}

/** Whether a raw text is a login request (cheap enough for every deep link and every scan). */
export function isLoginRequest(raw: string): boolean {
  return readLoginRequest(raw) !== null
}

/**
 * The web app the person is asked about, or null when the request cannot be answered safely: the
 * address must be an https or http origin, and the answer must go back to that same origin (client_id
 * scheme redirect_uri). The host shown is the address's, never the self-asserted `client_name`.
 */
export function loginTarget(r: LoginRequest): LoginTarget | null {
  const origin = originOf(r.client_id)
  if (origin === null || originOf(r.response_uri) !== origin) return null
  return { origin, host: new URL(origin).host }
}

/** Same-device: the app opens the web app's return address only on the web app's own origin. */
export function mayReturnTo(r: LoginRequest, url: string): boolean {
  const target = loginTarget(r)
  return target !== null && originOf(url) === target.origin
}

/** The app link for a request (web apps and tests build the QR code from it). */
export function loginLink(requestUrl: string): string {
  return `${LOGIN_LINK_ORIGIN}${LOGIN_LINK_PATH}#${encodeURIComponent(requestUrl)}`
}
