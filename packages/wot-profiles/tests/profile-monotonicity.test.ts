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

const PORT = 9888
const BASE_URL = `http://localhost:${PORT}`

describe('Profile REST API — server-side version monotonicity (VE-4)', () => {
  let server: ProfileServer
  let identity: PublicIdentitySession
  let did: string

  beforeAll(async () => {
    server = new ProfileServer({ port: PORT, dbPath: ':memory:' })
    await server.start()

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

describe('Profile REST API — lazy-read migration (VE-4 Schärfung)', () => {
  // A legacy row whose version lives ONLY in the stored JWS payload (NULL column)
  // must still serve as the monotonicity baseline. A stale PUT must NOT win just
  // because the version column was freshly added (and is NULL).
  let store: ProfileStore
  let identity: PublicIdentitySession
  let did: string
  const PORT2 = 9889
  const BASE_URL2 = `http://localhost:${PORT2}`
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

    server = new ProfileServer({ port: PORT2, dbPath })
    await server.start()

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
