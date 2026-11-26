// @vitest-environment node
// Login into a web app (experimental): the request a web app shows (SIOPv2 shape), as an app link and
// bare, and what the app accepts before it asks the person.
import { describe, expect, it } from 'vitest'
import { isLoginRequest, loginLink, loginTarget, mayReturnTo, readLoginRequest } from '../src/lib/login-request'

const request = (over: Record<string, string> = {}) => {
  const q = new URLSearchParams({
    response_type: 'id_token',
    response_mode: 'direct_post',
    scope: 'openid',
    id_token_type: 'subject_signed',
    client_id: 'https://beispiel.org',
    response_uri: 'https://beispiel.org/anmeldung/antwort',
    nonce: 'n-1',
    state: 's-1',
    client_name: 'Deine Bank',
    ...over,
  })
  return `openid://?${q.toString()}`
}

describe('login request', () => {
  it('reads the bare request and the app link alike', () => {
    const bare = readLoginRequest(request())
    expect(bare).toMatchObject({ client_id: 'https://beispiel.org', response_uri: 'https://beispiel.org/anmeldung/antwort', nonce: 'n-1', state: 's-1', client_name: 'Deine Bank' })
    expect(readLoginRequest(loginLink(request()))).toEqual(bare)
    expect(readLoginRequest(`https://web-of-trust.de/a/#${encodeURIComponent(request())}`)).toEqual(bare)
    expect(isLoginRequest(`  ${loginLink(request())}  `)).toBe(true)
  })

  it('refuses everything else: other hosts, other paths, other fields, missing fields', () => {
    expect(readLoginRequest(`https://andere.example/a#${encodeURIComponent(request())}`)).toBeNull()
    expect(readLoginRequest(`https://web-of-trust.de/c#${encodeURIComponent(request())}`)).toBeNull()
    expect(readLoginRequest('https://web-of-trust.de/a#kein-request')).toBeNull()
    expect(readLoginRequest('https://web-of-trust.de/a#%E0%A4%A')).toBeNull()
    expect(readLoginRequest(request({ response_type: 'code' }))).toBeNull()
    expect(readLoginRequest(request({ response_mode: 'fragment' }))).toBeNull()
    expect(readLoginRequest(request({ nonce: '' }))).toBeNull()
    expect(readLoginRequest('https://web-of-trust.de/c#card')).toBeNull()
  })

  it('names the web app by its address, never by its self-chosen name', () => {
    expect(loginTarget(readLoginRequest(request())!)).toEqual({ origin: 'https://beispiel.org', host: 'beispiel.org' })
  })

  it('refuses a request whose answer would go to another origin', () => {
    expect(loginTarget(readLoginRequest(request({ response_uri: 'https://angreifer.example/fang' }))!)).toBeNull()
    expect(loginTarget(readLoginRequest(request({ client_id: 'javascript:alert(1)' }))!)).toBeNull()
  })

  it('takes https only; plain http only on this machine (review #553)', () => {
    expect(loginTarget(readLoginRequest(request({ client_id: 'http://beispiel.org', response_uri: 'http://beispiel.org/antwort' }))!)).toBeNull()
    expect(loginTarget(readLoginRequest(request({ client_id: 'http://10.185.49.152:8790', response_uri: 'http://10.185.49.152:8790/antwort' }))!)).toBeNull()
    expect(loginTarget(readLoginRequest(request({ client_id: 'http://127.0.0.1:8790', response_uri: 'http://127.0.0.1:8790/antwort' }))!)).toEqual({ origin: 'http://127.0.0.1:8790', host: '127.0.0.1:8790' })
    expect(loginTarget(readLoginRequest(request({ client_id: 'http://localhost:5173', response_uri: 'http://localhost:5173/antwort' }))!)).not.toBeNull()
    expect(mayReturnTo(readLoginRequest(request())!, 'http://beispiel.org/fertig')).toBe(false)
  })

  it('returns only to the web app’s own origin', () => {
    const r = readLoginRequest(request())!
    expect(mayReturnTo(r, 'https://beispiel.org/fertig?response_code=x')).toBe(true)
    expect(mayReturnTo(r, 'https://angreifer.example/fertig?response_code=x')).toBe(false)
    expect(mayReturnTo(r, 'javascript:alert(1)')).toBe(false)
  })
})
