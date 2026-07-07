import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { IdentityWorkflow, type PublicIdentitySession } from '../../wot-core/src/application/identity'
import { WebCryptoProtocolCryptoAdapter } from '../../wot-core/src/adapters/protocol-crypto'
import { ProfileServer } from '../src/server.js'
import { ProfileStore } from '../src/profile-store.js'

/**
 * Server-side version monotonicity (VE-4, Sync 004 Z.155-164 MUSS).
 *
 * The wot-profiles server MUST enforce strict version monotonicity on PUT for
 * all three resources (`/p`, `/v`, `/a`): a PUT whose payload `version` is not
 * strictly greater than the currently stored version MUST be rejected with
 * HTTP 409 and the current stored `version` in the error body.
 *
 * The decision is delegated to the protocol pure function
 * `decideProfileResourcePutAcceptance` — NOT duplicated.
 */

// Dynamic OS-assigned ports (set in each beforeAll) — hardcoded ports collide with
// other packages' servers running concurrently under turbo (EADDRINUSE flake).
let BASE_URL = ''

describe('Profile REST API — server-side version monotonicity (VE-4)', () => {
  let server: ProfileServer
  let identity: PublicIdentitySession
  let did: string

  beforeAll(async () => {
    server = new ProfileServer({ port: 0, dbPath: ':memory:' })
    await server.start()
    BASE_URL = `http://localhost:${server.port}`

    const result = await new IdentityWorkflow({
      crypto: new WebCryptoProtocolCryptoAdapter(),
    }).createIdentity({ passphrase: 'monotonicity-test', storeSeed: false })
    identity = result.identity
    did = identity.getDid()
  })

  afterAll(async () => {
    await server.stop()
  })

  async function putProfile(version: number): Promise<Response> {
    const jws = await identity.signJws({
      did,
      version,
      didDocument: {
        id: did,
        verificationMethod: [],
        authentication: [],
        assertionMethod: [],
        keyAgreement: [],
      },
      profile: { name: 'Alice' },
      updatedAt: new Date().toISOString(),
    })
    return fetch(`${BASE_URL}/p/${encodeURIComponent(did)}`, {
      method: 'PUT',
      body: jws,
      headers: { 'Content-Type': 'application/jws' },
    })
  }

  async function putList(path: 'v' | 'a', version: number): Promise<Response> {
    const field = path === 'v' ? 'verifications' : 'attestations'
    const jws = await identity.signJws({
      did,
      version,
      [field]: [],
      updatedAt: new Date().toISOString(),
    })
    return fetch(`${BASE_URL}/p/${encodeURIComponent(did)}/${path}`, {
      method: 'PUT',
      body: jws,
      headers: { 'Content-Type': 'application/jws' },
    })
  }

  it('enforces monotonicity on /p: v5 → 200, v5 → 409(5), v6 → 200', async () => {
    expect((await putProfile(5)).status).toBe(200)

    const conflict = await putProfile(5)
    expect(conflict.status).toBe(409)
    const body = await conflict.json()
    expect(body.version).toBe(5)

    expect((await putProfile(6)).status).toBe(200)
  })

  it('enforces monotonicity on /v: v5 → 200, v5 → 409(5), v6 → 200', async () => {
    expect((await putList('v', 5)).status).toBe(200)

    const conflict = await putList('v', 5)
    expect(conflict.status).toBe(409)
    const body = await conflict.json()
    expect(body.version).toBe(5)

    expect((await putList('v', 6)).status).toBe(200)
  })

  it('enforces monotonicity on /a: v5 → 200, v5 → 409(5), v6 → 200', async () => {
    expect((await putList('a', 5)).status).toBe(200)

    const conflict = await putList('a', 5)
    expect(conflict.status).toBe(409)
    const body = await conflict.json()
    expect(body.version).toBe(5)

    expect((await putList('a', 6)).status).toBe(200)
  })

  it('rejects a lower version on /a: v6 → 409(6) after v6 stored', async () => {
    expect((await putList('a', 8)).status).toBe(200)
    const conflict = await putList('a', 7)
    expect(conflict.status).toBe(409)
    const body = await conflict.json()
    expect(body.version).toBe(8)
  })
})

describe('Profile REST API — mandatory integer version (review MAJOR 1, downgrade attack)', () => {
  // Regression for the review MAJOR-1 finding: a validly signed PUT WITHOUT a
  // `version` field (or with a non-integer `version`) was accepted with 200, the
  // version column written NULL, and — because the stored JWS also carried no
  // parsable version — every subsequent replay of an older signed resource was
  // accepted. Sync 004 Z.142 makes `version` a mandatory non-negative integer;
  // Z.196 maps a broken/incomplete payload to 400. Monotonicity must run on
  // EVERY PUT once a baseline exists, with no `version === undefined` opt-out.
  let BASE_URL3 = ''
  let server: ProfileServer
  let identity: PublicIdentitySession
  let did: string

  beforeAll(async () => {
    server = new ProfileServer({ port: 0, dbPath: ':memory:' })
    await server.start()
    BASE_URL3 = `http://localhost:${server.port}`
    const result = await new IdentityWorkflow({
      crypto: new WebCryptoProtocolCryptoAdapter(),
    }).createIdentity({ passphrase: 'mandatory-version-test', storeSeed: false })
    identity = result.identity
    did = identity.getDid()
  })

  afterAll(async () => {
    await server.stop()
  })

  /** Sign a spec-conformant list resource at `path` with an explicit `version` value (any type). */
  async function signList(path: 'v' | 'a', version: unknown): Promise<string> {
    const field = path === 'v' ? 'verifications' : 'attestations'
    return identity.signJws({
      did,
      version,
      [field]: [],
      updatedAt: new Date().toISOString(),
    })
  }

  /** Sign a list resource that OMITS the `version` field entirely. */
  async function signListNoVersion(path: 'v' | 'a'): Promise<string> {
    const field = path === 'v' ? 'verifications' : 'attestations'
    return identity.signJws({
      did,
      [field]: [],
      updatedAt: new Date().toISOString(),
    })
  }

  function put(path: 'v' | 'a', jws: string): Promise<Response> {
    return fetch(`${BASE_URL3}/p/${encodeURIComponent(did)}/${path}`, {
      method: 'PUT',
      body: jws,
      headers: { 'Content-Type': 'application/jws' },
    })
  }

  it('(a) rejects a validly signed PUT with no version field after v10 with 400, leaving v10 intact', async () => {
    expect((await put('a', await signList('a', 10))).status).toBe(200)

    // A validly signed PUT WITHOUT a version field MUST be 400, not 200.
    const noVersion = await put('a', await signListNoVersion('a'))
    expect(noVersion.status).toBe(400)

    // v10 must remain the stored baseline: a downgrade-replay to v9 must 409(10).
    const downgrade = await put('a', await signList('a', 9))
    expect(downgrade.status).toBe(409)
    expect((await downgrade.json()).version).toBe(10)
  })

  it('(b) rejects a string version "5" with 400', async () => {
    const res = await put('v', await signList('v', '5'))
    expect(res.status).toBe(400)
  })

  it('(c) rejects negative and fractional versions with 400', async () => {
    expect((await put('a', await signList('a', -1))).status).toBe(400)
    expect((await put('a', await signList('a', 2.5))).status).toBe(400)
  })
})

describe('Profile REST API — lazy-read migration (VE-4 Schärfung)', () => {
  // A legacy row whose version lives ONLY in the stored JWS payload (NULL column)
  // must still serve as the monotonicity baseline. A stale PUT must NOT win just
  // because the version column was freshly added (and is NULL).
  let store: ProfileStore
  let identity: PublicIdentitySession
  let did: string
  let BASE_URL2 = ''
  let server: ProfileServer

  beforeAll(async () => {
    const result = await new IdentityWorkflow({
      crypto: new WebCryptoProtocolCryptoAdapter(),
    }).createIdentity({ passphrase: 'lazy-read-test', storeSeed: false })
    identity = result.identity
    did = identity.getDid()
  })

  afterAll(async () => {
    if (server) await server.stop()
  })

  async function signList(path: 'v' | 'a', version: number): Promise<string> {
    const field = path === 'v' ? 'verifications' : 'attestations'
    return identity.signJws({
      did,
      version,
      [field]: [],
      updatedAt: new Date().toISOString(),
    })
  }

  it('uses the version from a stored JWS when the column is NULL (legacy row): v6 → 409(7), v8 → 200', async () => {
    // Seed a legacy attestations row directly into the DB with version 7 in the
    // JWS but a NULL version column (simulating a row written before the column
    // existed). We do this by inserting via the store's low-level put, then
    // explicitly NULLing the version column.
    const dbPath = `/tmp/wot-profiles-lazy-${Date.now()}.db`
    store = new ProfileStore(dbPath)
    const legacyJws = await signList('a', 7)
    store.putAttestations(did, legacyJws)
    // Force the column back to NULL to emulate a pre-migration row.
    store.__nullifyVersionForTest('attestations', did)
    store.close()

    server = new ProfileServer({ port: 0, dbPath })
    await server.start()
    BASE_URL2 = `http://localhost:${server.port}`

    const stale = await fetch(`${BASE_URL2}/p/${encodeURIComponent(did)}/a`, {
      method: 'PUT',
      body: await signList('a', 6),
      headers: { 'Content-Type': 'application/jws' },
    })
    expect(stale.status).toBe(409)
    const body = await stale.json()
    expect(body.version).toBe(7)

    const ok = await fetch(`${BASE_URL2}/p/${encodeURIComponent(did)}/a`, {
      method: 'PUT',
      body: await signList('a', 8),
      headers: { 'Content-Type': 'application/jws' },
    })
    expect(ok.status).toBe(200)
  })
})
