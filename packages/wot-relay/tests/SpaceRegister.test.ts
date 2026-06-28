import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { randomUUID } from 'crypto'
import WebSocket from 'ws'
import { RelayServer } from '../src/relay.js'
import type { RelayMessage } from '../src/types.js'
import { protocol, WebCryptoProtocolCryptoAdapter } from '@web_of_trust/core'

// Slice CG / Phase 3 (VE-3) — `space-register` control-frame on the REAL relay.
// An admin identity (whose DID is in adminDids) signs the inner JWS; the broker
// verifies TOFU (kid-DID ∈ adminDids + Ed25519 signature) and binds
// (spaceId → verificationKey, adminDids) first-writer-wins in the durable space
// registry. This phase records the binding only — it does NOT yet gate
// log-entry/sync-request (that is the capability gate, Phase 4), so the existing
// DurableLogSync suite is untouched.

const PORT = 9887
const RELAY_URL = `ws://localhost:${PORT}`

const cryptoAdapter = new WebCryptoProtocolCryptoAdapter()
const {
  buildBrokerAuthTranscript,
  createBrokerAuthTranscriptSigningBytes,
  formatBrokerChallengeResponseSignature,
} = protocol

// --- raw-seed identity (an admin signs the space-register inner JWS) ----------

interface RawIdentity {
  seed: Uint8Array
  did: string
  authorKid: string
  deviceId: string
  signTranscriptBytes: (bytes: Uint8Array) => Promise<Uint8Array>
}

// RFC 8410 PKCS8 prefix for an Ed25519 private key (raw 32-byte seed → WebCrypto
// signing key) so the broker verifies the challenge-response transcript signature
// against the seed-derived did:key. The space-register inner JWS itself is signed
// by core (createSpaceRegisterMessage / createJcsEd25519Jws), not here.
const ED25519_PKCS8_PREFIX = Uint8Array.from([
  0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x04, 0x22, 0x04, 0x20,
])

async function seedToSigningKey(seed: Uint8Array) {
  const pkcs8 = new Uint8Array(ED25519_PKCS8_PREFIX.length + seed.length)
  pkcs8.set(ED25519_PKCS8_PREFIX)
  pkcs8.set(seed, ED25519_PKCS8_PREFIX.length)
  return crypto.subtle.importKey('pkcs8', pkcs8, { name: 'Ed25519' }, false, ['sign'])
}

async function makeRawIdentity(label: string): Promise<RawIdentity> {
  const seed = await cryptoAdapter.sha256(new TextEncoder().encode(`space-register-test/seed/${label}`))
  const pub = await cryptoAdapter.ed25519PublicKeyFromSeed(seed)
  const did = protocol.publicKeyToDidKey(pub)
  const signingKey = await seedToSigningKey(seed)
  return {
    seed,
    did,
    authorKid: `${did}#sig-0`,
    deviceId: randomUUID(),
    signTranscriptBytes: async (bytes) =>
      new Uint8Array(await crypto.subtle.sign('Ed25519', signingKey, bytes)),
  }
}

// --- minimal authenticated relay client over ws ------------------------------

type SendOutcome = Record<string, unknown> | { error: string; clientHint?: string }

class TestClient {
  private ws: WebSocket | null = null
  private outcomeWaiters: Array<(outcome: SendOutcome) => void> = []

  constructor(private identity: RawIdentity) {}

  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(RELAY_URL)
      this.ws = ws
      ws.on('open', () => {
        ws.send(JSON.stringify({ type: 'register', did: this.identity.did, deviceId: this.identity.deviceId }))
      })
      ws.on('message', (data) => {
        const msg = JSON.parse(data.toString()) as RelayMessage
        switch (msg.type) {
          case 'challenge': {
            const transcript = buildBrokerAuthTranscript({
              did: this.identity.did,
              deviceId: this.identity.deviceId,
              nonce: msg.nonce,
            })
            const signingBytes = createBrokerAuthTranscriptSigningBytes(transcript)
            this.identity
              .signTranscriptBytes(signingBytes)
              .then((sig) => {
                ws.send(
                  JSON.stringify({
                    type: 'challenge-response',
                    did: this.identity.did,
                    deviceId: this.identity.deviceId,
                    nonce: msg.nonce,
                    signature: formatBrokerChallengeResponseSignature(sig),
                  }),
                )
              })
              .catch(reject)
            break
          }
          case 'registered':
            resolve()
            break
          case 'receipt': {
            const waiter = this.outcomeWaiters.shift()
            if (waiter) waiter(msg.receipt as unknown as Record<string, unknown>)
            break
          }
          case 'error': {
            const waiter = this.outcomeWaiters.shift()
            if (waiter) waiter({ error: msg.code, clientHint: msg.clientHint })
            break
          }
        }
      })
      ws.on('error', reject)
    })
  }

  /**
   * Send a RAW top-level control frame (not wrapped in `{type:'send',envelope}`)
   * and resolve on the matching receipt OR error. space-register is a top-level
   * control-frame in handleMessage, like device-revoke.
   */
  sendControlFrame(frame: Record<string, unknown>): Promise<SendOutcome> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Timeout waiting for control-frame outcome')), 2000)
      this.outcomeWaiters.push((outcome) => {
        clearTimeout(timer)
        resolve(outcome)
      })
      this.ws!.send(JSON.stringify(frame))
    })
  }

  /**
   * Build (via the core primitive) and send a `space-register` control-frame whose
   * inner JWS is signed by `signer` (an admin identity whose DID MUST be in
   * `adminDids`). Resolves on the relay's receipt OR error.
   */
  sendSpaceRegister(params: {
    signer: RawIdentity
    spaceId: string
    spaceCapabilityVerificationKey: string
    adminDids: string[]
  }): Promise<SendOutcome> {
    return this.buildAndSendSpaceRegister(params)
  }

  private async buildAndSendSpaceRegister(params: {
    signer: RawIdentity
    spaceId: string
    spaceCapabilityVerificationKey: string
    adminDids: string[]
  }): Promise<SendOutcome> {
    const frame = await protocol.createSpaceRegisterMessage({
      spaceId: params.spaceId,
      spaceCapabilityVerificationKey: params.spaceCapabilityVerificationKey,
      adminDids: params.adminDids,
      kid: params.signer.authorKid,
      signingSeed: params.signer.seed,
    })
    return this.sendControlFrame(frame as unknown as Record<string, unknown>)
  }

  disconnect(): Promise<void> {
    return new Promise((resolve) => {
      if (!this.ws) return resolve()
      this.ws.on('close', () => resolve())
      this.ws.close()
      this.ws = null
    })
  }
}

/**
 * Build a space-register frame whose inner JWS is signed by a kid-DID that is NOT
 * in adminDids. createSpaceRegisterMessage forbids this (it asserts kid-DID ∈
 * adminDids), so we assemble the inner JWS directly via createJcsEd25519Jws — the
 * broker must reject it with AUTH_INVALID (TOFU: signer not self-asserted).
 */
async function buildSpaceRegisterWithForeignSigner(params: {
  signer: RawIdentity
  spaceId: string
  spaceCapabilityVerificationKey: string
  adminDids: string[]
}): Promise<Record<string, unknown>> {
  const payload = {
    type: 'space-register',
    spaceId: params.spaceId,
    spaceCapabilityVerificationKey: params.spaceCapabilityVerificationKey,
    adminDids: params.adminDids,
  }
  const registrationJws = await protocol.createJcsEd25519Jws(
    { alg: 'EdDSA', kid: params.signer.authorKid },
    payload as unknown as protocol.JsonValue,
    params.signer.seed,
  )
  return { type: 'space-register', registrationJws }
}

const VK = 'c3BhY2VDYXBhYmlsaXR5VmVyaWZpY2F0aW9uS2V5LWdlbjA' // base64url-ish token

describe('space-register control-frame over the real relay (Slice CG / VE-3)', () => {
  let server: RelayServer

  beforeEach(async () => {
    server = new RelayServer({ port: PORT })
    await server.start()
  })

  afterEach(async () => {
    await server.stop()
  })

  it('TOFU: an admin (kid-DID ∈ adminDids) registers a space → delivered, durable binding at generation 0', async () => {
    const admin = await makeRawIdentity('admin-register')
    const client = new TestClient(admin)
    await client.connect()

    const spaceId = randomUUID()
    const outcome = await client.sendSpaceRegister({
      signer: admin,
      spaceId,
      spaceCapabilityVerificationKey: VK,
      adminDids: [admin.did],
    })
    expect((outcome as Record<string, unknown>).status).toBe('delivered')

    // Durable binding recorded (generation 0 + admin set).
    const docLog = (server as unknown as {
      docLog: {
        getSpace: (id: string) => { verificationKey: string; generation: number } | null
        getSpaceAdmins: (id: string) => string[]
        isSpaceRegistered: (id: string) => boolean
      }
    }).docLog
    expect(docLog.isSpaceRegistered(spaceId)).toBe(true)
    expect(docLog.getSpace(spaceId)).toEqual({ verificationKey: VK, generation: 0 })
    expect(docLog.getSpaceAdmins(spaceId)).toEqual([admin.did])

    await client.disconnect()
  })

  it('idempotent: re-registering the IDENTICAL space (same key + admin set) → delivered, no conflict', async () => {
    const admin = await makeRawIdentity('admin-idempotent')
    const client = new TestClient(admin)
    await client.connect()

    const spaceId = randomUUID()
    const reg = {
      signer: admin,
      spaceId,
      spaceCapabilityVerificationKey: VK,
      adminDids: [admin.did],
    }
    expect(((await client.sendSpaceRegister(reg)) as Record<string, unknown>).status).toBe('delivered')
    // Identical recovery re-register (idempotent path) → still delivered.
    expect(((await client.sendSpaceRegister(reg)) as Record<string, unknown>).status).toBe('delivered')

    await client.disconnect()
  })

  it('first-writer-wins: a re-register with a DIVERGENT verification key → SPACE_ALREADY_REGISTERED', async () => {
    const admin = await makeRawIdentity('admin-divergent-key')
    const client = new TestClient(admin)
    await client.connect()

    const spaceId = randomUUID()
    expect(
      ((await client.sendSpaceRegister({
        signer: admin,
        spaceId,
        spaceCapabilityVerificationKey: VK,
        adminDids: [admin.did],
      })) as Record<string, unknown>).status,
    ).toBe('delivered')

    // Same admin signs, same spaceId, DIFFERENT verification key → conflict.
    const conflict = await client.sendSpaceRegister({
      signer: admin,
      spaceId,
      spaceCapabilityVerificationKey: 'ZGlmZmVyZW50LXZlcmlmaWNhdGlvbi1rZXk',
      adminDids: [admin.did],
    })
    expect(conflict).toMatchObject({ error: 'SPACE_ALREADY_REGISTERED' })

    await client.disconnect()
  })

  it('first-writer-wins: a re-register with a DIVERGENT admin set → SPACE_ALREADY_REGISTERED', async () => {
    const adminA = await makeRawIdentity('admin-set-a')
    const adminB = await makeRawIdentity('admin-set-b')
    const client = new TestClient(adminA)
    await client.connect()

    const spaceId = randomUUID()
    expect(
      ((await client.sendSpaceRegister({
        signer: adminA,
        spaceId,
        spaceCapabilityVerificationKey: VK,
        adminDids: [adminA.did],
      })) as Record<string, unknown>).status,
    ).toBe('delivered')

    // Same key, but the admin set now includes adminB → divergent set → conflict.
    // adminA still signs (kid-DID ∈ the new adminDids, so verification passes; the
    // conflict is decided against the durable binding, not the signature).
    const conflict = await client.sendSpaceRegister({
      signer: adminA,
      spaceId,
      spaceCapabilityVerificationKey: VK,
      adminDids: [adminA.did, adminB.did],
    })
    expect(conflict).toMatchObject({ error: 'SPACE_ALREADY_REGISTERED' })

    await client.disconnect()
  })

  it('a malformed outer frame (extra top-level field) is rejected with MALFORMED_MESSAGE', async () => {
    const admin = await makeRawIdentity('admin-malformed')
    const client = new TestClient(admin)
    await client.connect()

    const spaceId = randomUUID()
    const valid = await protocol.createSpaceRegisterMessage({
      spaceId,
      spaceCapabilityVerificationKey: VK,
      adminDids: [admin.did],
      kid: admin.authorKid,
      signingSeed: admin.seed,
    })
    // The outer frame MUST carry exactly {type, registrationJws} (closed control-frame).
    const malformed = { ...(valid as unknown as Record<string, unknown>), thid: randomUUID() }
    expect(await client.sendControlFrame(malformed)).toMatchObject({ error: 'MALFORMED_MESSAGE' })

    // Nothing was bound by the malformed frame.
    const docLog = (server as unknown as { docLog: { isSpaceRegistered: (id: string) => boolean } }).docLog
    expect(docLog.isSpaceRegistered(spaceId)).toBe(false)

    await client.disconnect()
  })

  it('an inner JWS signed by a NON-listed did (kid-DID ∉ adminDids) is rejected with AUTH_INVALID', async () => {
    const admin = await makeRawIdentity('admin-listed')
    const outsider = await makeRawIdentity('outsider-nonlisted')
    const client = new TestClient(admin)
    await client.connect()

    const spaceId = randomUUID()
    // adminDids lists ONLY admin.did, but the inner JWS is signed by outsider →
    // TOFU self-asserting check fails (kid-DID ∉ adminDids) → AUTH_INVALID.
    const frame = await buildSpaceRegisterWithForeignSigner({
      signer: outsider,
      spaceId,
      spaceCapabilityVerificationKey: VK,
      adminDids: [admin.did],
    })
    expect(await client.sendControlFrame(frame)).toMatchObject({ error: 'AUTH_INVALID' })

    // No binding established.
    const docLog = (server as unknown as { docLog: { isSpaceRegistered: (id: string) => boolean } }).docLog
    expect(docLog.isSpaceRegistered(spaceId)).toBe(false)

    await client.disconnect()
  })
})
