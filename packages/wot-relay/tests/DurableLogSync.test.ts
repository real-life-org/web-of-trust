import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { randomUUID, randomBytes } from 'crypto'
import WebSocket from 'ws'
import { RelayServer } from '../src/relay.js'
import type { RelayMessage } from '../src/types.js'
import { protocol, WebCryptoProtocolCryptoAdapter } from '@web_of_trust/core'

// Slice R / Sync 002 — durable-log catch-up on the REAL relay (mirrors sync-spike
// probe 01). Producers push real log-entry JWS, then DISCONNECT; a fresh device
// connects AFTER they are gone and reconstructs the full document via a
// sync-request served from the durable log (NOT live broadcast). That ordering is
// the teeth: it proves durability, not realtime fan-out.

const PORT = 9884
const RELAY_URL = `ws://localhost:${PORT}`
const FIXED_TIMESTAMP = '2026-06-22T10:00:00Z'
// Capability validity window: far-future validUntil so `now < validUntil` always
// holds at the broker (Sync 003 §Capability-Prüfung). issuedAt is in the past.
const CAP_ISSUED_AT = '2026-01-01T00:00:00Z'
const CAP_VALID_UNTIL = '2099-01-01T00:00:00Z'

// Vector-validated WebCrypto adapter for SHA-256 / Ed25519 key derivation. The
// global `crypto` (Node WebCrypto) is used directly for detached subtle signing.
const cryptoAdapter = new WebCryptoProtocolCryptoAdapter()
const {
  buildBrokerAuthTranscript,
  createBrokerAuthTranscriptSigningBytes,
  formatBrokerChallengeResponseSignature,
} = protocol

// --- Space Capability keypair (Phase 4 / Sync 003 §Capability-Format) ---------
//
// A space has a Space Capability KEY PAIR distinct from any identity DID: members
// sign capabilities with the shared signing seed, the broker verifies with the
// base64url-encoded public key registered via `space-register`. Generate a random
// Ed25519 seed and derive the verification key the broker stores.

interface SpaceCapabilityKeypair {
  signingSeed: Uint8Array
  /** base64url(Ed25519 public key) — the registered spaceCapabilityVerificationKey. */
  verificationKey: string
}

async function makeSpaceCapabilityKeypair(): Promise<SpaceCapabilityKeypair> {
  const signingSeed = new Uint8Array(randomBytes(32))
  const pub = await cryptoAdapter.ed25519PublicKeyFromSeed(signingSeed)
  return { signingSeed, verificationKey: protocol.encodeBase64Url(pub) }
}

/**
 * Mint a Space capability JWS (kid = `wot:space:<spaceId>#cap-<generation>`,
 * computed inside createSpaceCapabilityJws) for one audience DID. Signed with the
 * space's capability signing seed; the broker verifies it against the registered
 * verification key at the matching generation.
 */
async function mintSpaceCapability(params: {
  keypair: SpaceCapabilityKeypair
  spaceId: string
  audience: string
  permissions: Array<'read' | 'write'>
  generation?: number
}): Promise<string> {
  return protocol.createSpaceCapabilityJws({
    payload: {
      type: 'capability',
      spaceId: params.spaceId,
      audience: params.audience,
      permissions: params.permissions,
      generation: params.generation ?? 0,
      issuedAt: CAP_ISSUED_AT,
      validUntil: CAP_VALID_UNTIL,
    },
    signingSeed: params.keypair.signingSeed,
  })
}

/**
 * Mint a self-issued Personal-Doc capability JWS (kid = the owner's identity
 * verification-method id `<did>#<vm>`; generation MUST be 0). Signed with the
 * owner's Identity Key seed; the broker verifies it against the authenticated
 * DID's identity key (Sync 003 §Persönliche Dokumente).
 */
async function mintPersonalDocCapability(params: {
  owner: RawIdentity
  docId: string
  permissions: Array<'read' | 'write'>
  validUntil?: string
}): Promise<string> {
  return protocol.createPersonalDocCapabilityJws({
    payload: {
      type: 'capability',
      spaceId: params.docId,
      audience: params.owner.did,
      permissions: params.permissions,
      generation: 0,
      issuedAt: CAP_ISSUED_AT,
      validUntil: params.validUntil ?? CAP_VALID_UNTIL,
    },
    kid: params.owner.authorKid,
    signingSeed: params.owner.seed,
  })
}

// --- raw-seed identity (needed to PRODUCE valid log-entry JWS) ---------------

interface RawIdentity {
  seed: Uint8Array
  did: string
  authorKid: string
  deviceId: string
  signTranscriptBytes: (bytes: Uint8Array) => Promise<Uint8Array>
}

// RFC 8410 PKCS8 prefix for an Ed25519 private key, so a raw 32-byte seed can be
// imported into WebCrypto for detached signing. The same seed yields the same
// public key as core's ed25519PublicKeyFromSeed (noble), so the broker verifies
// these transcript signatures against the seed-derived did:key. The log-entry
// JWS itself is signed by core (createLogEntryJws), not here.
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
  const seed = await cryptoAdapter.sha256(new TextEncoder().encode(`durable-sync-test/seed/${label}`))
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

async function deriveSpaceContentKey(docId: string, generation = 0): Promise<Uint8Array> {
  return cryptoAdapter.sha256(new TextEncoder().encode(`sck|${docId}|gen${generation}`))
}

// --- space setup + capability presentation helpers (Phase 4) -----------------
//
// SPACE path: a space is registered at the broker by an admin (whose DID is in
// adminDids), then every participating client presents a per-audience capability
// (write for producers, read for catch-up readers) BEFORE its first
// log-entry/sync-request. These wrap the per-client presentCapability + the
// admin's sendSpaceRegister so each migrated test reads as a one-liner.

interface SpaceParticipant {
  client: TestClient
  identity: RawIdentity
  permissions: Array<'read' | 'write'>
}

/**
 * Register `spaceId` via `admin` (its DID is the sole adminDid) over the admin's
 * authenticated client, then have every participant present a Space capability
 * minted for its own DID. Asserts each step is `delivered` so a setup regression
 * fails loudly at setup rather than as a confusing downstream CAPABILITY_REQUIRED.
 */
async function setupSpace(params: {
  spaceId: string
  keypair: SpaceCapabilityKeypair
  admin: { client: TestClient; identity: RawIdentity }
  participants: SpaceParticipant[]
}): Promise<void> {
  const reg = await params.admin.client.sendSpaceRegister({
    signer: params.admin.identity,
    spaceId: params.spaceId,
    spaceCapabilityVerificationKey: params.keypair.verificationKey,
    adminDids: [params.admin.identity.did],
  })
  expect((reg as Record<string, unknown>).status).toBe('delivered')

  for (const participant of params.participants) {
    await presentSpaceCapability({
      client: participant.client,
      keypair: params.keypair,
      spaceId: params.spaceId,
      audience: participant.identity.did,
      permissions: participant.permissions,
    })
  }
}

/**
 * Mint + present a Space capability on `client`'s socket (its own DID as audience)
 * and assert it is `delivered`. Used for clients that connect AFTER setupSpace —
 * e.g. the fresh catch-up reader that comes online once producers are gone (scope
 * presentation is per-socket, so it cannot be done up-front in setupSpace).
 */
async function presentSpaceCapability(params: {
  client: TestClient
  keypair: SpaceCapabilityKeypair
  spaceId: string
  audience: string
  permissions: Array<'read' | 'write'>
}): Promise<void> {
  const cap = await mintSpaceCapability({
    keypair: params.keypair,
    spaceId: params.spaceId,
    audience: params.audience,
    permissions: params.permissions,
  })
  const outcome = await params.client.presentCapability(cap)
  expect((outcome as Record<string, unknown>).status).toBe('delivered')
}

// --- minimal authenticated relay client over ws ------------------------------

type SendOutcome = Record<string, unknown> | { error: string; clientHint?: string }

class TestClient {
  private ws: WebSocket | null = null
  readonly messages: Record<string, unknown>[] = []
  /** FIFO of resolvers for the next receipt-or-error (sends are awaited serially). */
  private outcomeWaiters: Array<(outcome: SendOutcome) => void> = []
  private messageWaiters: Array<(env: Record<string, unknown>) => void> = []

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
          case 'message': {
            this.messages.push(msg.envelope)
            const waiter = this.messageWaiters.shift()
            if (waiter) waiter(msg.envelope)
            break
          }
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

  /** Send a transport envelope; resolves on the matching receipt OR an error. */
  send(envelope: Record<string, unknown>): Promise<SendOutcome> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Timeout waiting for send outcome')), 2000)
      this.outcomeWaiters.push((outcome) => {
        clearTimeout(timer)
        resolve(outcome)
      })
      this.ws!.send(JSON.stringify({ type: 'send', envelope }))
    })
  }

  /**
   * Send a RAW top-level control frame (not wrapped in `{type:'send',envelope}`)
   * and resolve on the matching receipt OR error. Used for the device-revoke
   * control-frame, which is a top-level frame in handleMessage.
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
   * Present a capability for a docId (Sync 003 §Capability-Prüfung). Sends the
   * CLOSED `present-capability` control-frame and resolves on the receipt OR error.
   */
  presentCapability(capabilityJws: string): Promise<SendOutcome> {
    return this.sendControlFrame({ type: 'present-capability', capabilityJws })
  }

  /**
   * Build (via the core primitive) and send a `space-register` control-frame whose
   * inner JWS is signed by `signer` (an admin identity whose DID MUST be in
   * `adminDids`). Resolves on the relay's receipt OR error. Mirrors the Phase-3
   * SpaceRegister harness.
   */
  async sendSpaceRegister(params: {
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

  /** Send a sync-request and wait for the sync-response message envelope. */
  syncRequest(envelope: Record<string, unknown>): Promise<Record<string, unknown>> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Timeout waiting for sync-response')), 2000)
      this.messageWaiters.push((env) => {
        clearTimeout(timer)
        resolve(env)
      })
      this.ws!.send(JSON.stringify({ type: 'send', envelope }))
    })
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

// --- log-entry / sync-request envelope builders ------------------------------

async function buildLogEntryJws(params: {
  identity: RawIdentity
  docId: string
  seq: number
  plaintext: string
  keyGeneration?: number
  /** Override the payload deviceId (defaults to the signer's own). Used by the
   *  VE-3a test to forge an entry that claims ANOTHER device's namespace while
   *  still being validly signed by this identity's authorKid. */
  deviceId?: string
}): Promise<string> {
  const generation = params.keyGeneration ?? 0
  const deviceId = params.deviceId ?? params.identity.deviceId
  const spaceContentKey = await deriveSpaceContentKey(params.docId, generation)
  const enc = await protocol.encryptLogPayload({
    crypto: cryptoAdapter,
    spaceContentKey,
    deviceId,
    seq: params.seq,
    plaintext: new TextEncoder().encode(params.plaintext),
  })
  const payload = {
    seq: params.seq,
    deviceId,
    docId: params.docId,
    authorKid: params.identity.authorKid,
    keyGeneration: generation,
    data: enc.blobBase64Url,
    timestamp: FIXED_TIMESTAMP,
  }
  return protocol.createLogEntryJws({ payload, signingSeed: params.identity.seed })
}

function logEntryEnvelope(from: string, to: string[], entryJws: string): Record<string, unknown> {
  return protocol.createLogEntryMessage({
    id: randomUUID(),
    from,
    to,
    createdTime: Math.floor(Date.now() / 1000),
    entry: entryJws,
  }) as unknown as Record<string, unknown>
}

function syncRequestEnvelope(
  from: string,
  docId: string,
  heads: Record<string, number>,
  limit?: number,
): Record<string, unknown> {
  return protocol.createSyncRequestMessage({
    id: randomUUID(),
    from,
    createdTime: Math.floor(Date.now() / 1000),
    body: limit === undefined ? { docId, heads } : { docId, heads, limit },
  }) as unknown as Record<string, unknown>
}

/**
 * Build a Sync 003 `device-revoke` control-frame: the inner JWS payload
 * `{ type, did, deviceId, revokedAt }` is signed by the DID's Identity Key (raw
 * seed). The header `kid` MUST resolve to `did` (the core verifier checks
 * didOrKidToDid(kid) === payload.did), so we use the identity's authorKid.
 */
async function buildDeviceRevokeFrame(
  identity: RawIdentity,
  deviceId: string,
  revokedAt: string,
): Promise<Record<string, unknown>> {
  const payload = { type: 'device-revoke', did: identity.did, deviceId, revokedAt }
  const revocationJws = await protocol.createJcsEd25519Jws(
    { alg: 'EdDSA', kid: identity.authorKid },
    payload as unknown as protocol.JsonValue,
    identity.seed,
  )
  return { type: 'device-revoke', revocationJws }
}

/**
 * Drive the register → challenge-response handshake manually and resolve with the
 * relay's `error` frame instead of a `registered` frame. Used for registration
 * rejections (DEVICE_ID_CONFLICT / DEVICE_REVOKED) where connect() would never
 * resolve because no `registered` frame is sent.
 */
function connectExpectingError(identity: RawIdentity): Promise<{ code: string }> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(RELAY_URL)
    const timer = setTimeout(() => {
      ws.close()
      reject(new Error('Timeout waiting for registration error'))
    }, 2000)
    ws.on('open', () => {
      ws.send(JSON.stringify({ type: 'register', did: identity.did, deviceId: identity.deviceId }))
    })
    ws.on('message', (data) => {
      const msg = JSON.parse(data.toString()) as RelayMessage
      if (msg.type === 'challenge') {
        const transcript = buildBrokerAuthTranscript({
          did: identity.did,
          deviceId: identity.deviceId,
          nonce: msg.nonce,
        })
        const signingBytes = createBrokerAuthTranscriptSigningBytes(transcript)
        identity
          .signTranscriptBytes(signingBytes)
          .then((sig) => {
            ws.send(
              JSON.stringify({
                type: 'challenge-response',
                did: identity.did,
                deviceId: identity.deviceId,
                nonce: msg.nonce,
                signature: formatBrokerChallengeResponseSignature(sig),
              }),
            )
          })
          .catch(reject)
      } else if (msg.type === 'registered') {
        clearTimeout(timer)
        ws.close()
        reject(new Error('Expected a registration error, got `registered`'))
      } else if (msg.type === 'error') {
        clearTimeout(timer)
        ws.close()
        resolve({ code: msg.code })
      }
    })
    ws.on('error', reject)
  })
}

/** Decrypt + collect plaintexts from a list of log-entry JWS (verifies signatures). */
async function reconstruct(jwsList: string[], docId: string): Promise<string[]> {
  const out: string[] = []
  for (const jws of jwsList) {
    const payload = await protocol.verifyLogEntryJws(jws, { crypto: cryptoAdapter })
    const key = await deriveSpaceContentKey(payload.docId, payload.keyGeneration)
    const blob = protocol.decodeBase64Url(payload.data)
    const plaintext = await protocol.decryptLogPayload({ crypto: cryptoAdapter, spaceContentKey: key, blob })
    expect(payload.docId).toBe(docId)
    out.push(new TextDecoder().decode(plaintext))
  }
  return out
}

describe('Durable log sync over the real relay (Slice R / Sync 002)', () => {
  let server: RelayServer

  beforeEach(async () => {
    server = new RelayServer({ port: PORT })
    await server.start()
  })

  afterEach(async () => {
    await server.stop()
  })

  it('cold reconstruction: a fresh device rebuilds the full doc via sync-request after all producers disconnect', async () => {
    const docId = randomUUID()
    const alice = await makeRawIdentity('alice')
    const bob = await makeRawIdentity('bob')
    const fresh = await makeRawIdentity('fresh')

    const aliceClient = new TestClient(alice)
    const bobClient = new TestClient(bob)
    await aliceClient.connect()
    await bobClient.connect()

    // SPACE path: register the shared space (alice = admin) and present a WRITE
    // capability for each producer before they push log entries.
    const keypair = await makeSpaceCapabilityKeypair()
    await setupSpace({
      spaceId: docId,
      keypair,
      admin: { client: aliceClient, identity: alice },
      participants: [
        { client: aliceClient, identity: alice, permissions: ['write'] },
        { client: bobClient, identity: bob, permissions: ['write'] },
      ],
    })

    // Two producer devices push several log entries (interleaved devices).
    const written: { jws: string; text: string }[] = []
    const writeFrom = async (producer: TestClient, id: RawIdentity, seq: number, text: string) => {
      const jws = await buildLogEntryJws({ identity: id, docId, seq, plaintext: text })
      written.push({ jws, text })
      const res = await producer.send(logEntryEnvelope(id.did, [fresh.did], jws))
      expect((res as Record<string, unknown>).status).toBe('delivered')
    }

    await writeFrom(aliceClient, alice, 0, 'alice-0')
    await writeFrom(bobClient, bob, 0, 'bob-0')
    await writeFrom(aliceClient, alice, 1, 'alice-1')
    await writeFrom(aliceClient, alice, 2, 'alice-2')
    await writeFrom(bobClient, bob, 1, 'bob-1')

    // Producers go away BEFORE the fresh device connects — reconstruction must
    // come from the durable log, not from any live broadcast.
    await aliceClient.disconnect()
    await bobClient.disconnect()
    expect(server.connectedDids).toHaveLength(0)

    // Fresh device authenticates, presents a READ capability, and asks for the
    // full log (EMPTY heads).
    const freshClient = new TestClient(fresh)
    await freshClient.connect()
    await presentSpaceCapability({ client: freshClient, keypair, spaceId: docId, audience: fresh.did, permissions: ['read'] })
    const response = await freshClient.syncRequest(syncRequestEnvelope(fresh.did, docId, {}))

    expect(response.type).toBe(protocol.SYNC_RESPONSE_MESSAGE_TYPE)
    const body = response.body as { docId: string; entries: string[]; heads: Record<string, number>; truncated: boolean }
    expect(body.docId).toBe(docId)
    expect(body.truncated).toBe(false)
    expect(body.entries).toHaveLength(written.length)
    expect(body.heads).toEqual({ [alice.deviceId]: 2, [bob.deviceId]: 1 })

    // The fresh device decrypts + reconstructs the exact content written.
    const reconstructed = await reconstruct(body.entries, docId)
    expect(new Set(reconstructed)).toEqual(new Set(written.map((w) => w.text)))

    await freshClient.disconnect()
  })

  it('cold reconstruction survives a producer reconnect (durable, no delete-on-ACK)', async () => {
    const docId = randomUUID()
    const alice = await makeRawIdentity('alice2')
    const fresh = await makeRawIdentity('fresh2')

    const keypair = await makeSpaceCapabilityKeypair()
    const aliceClient = new TestClient(alice)
    await aliceClient.connect()
    // SPACE path: alice (admin) registers the space + presents a WRITE capability.
    await setupSpace({
      spaceId: docId,
      keypair,
      admin: { client: aliceClient, identity: alice },
      participants: [{ client: aliceClient, identity: alice, permissions: ['write'] }],
    })
    const jws0 = await buildLogEntryJws({ identity: alice, docId, seq: 0, plaintext: 'persist-0' })
    await aliceClient.send(logEntryEnvelope(alice.did, [fresh.did], jws0))
    await aliceClient.disconnect()

    // First fresh device reconstructs (presents a READ capability — the space
    // registration is durable across the producer disconnect).
    const fresh1 = new TestClient(fresh)
    await fresh1.connect()
    await presentSpaceCapability({ client: fresh1, keypair, spaceId: docId, audience: fresh.did, permissions: ['read'] })
    const r1 = await fresh1.syncRequest(syncRequestEnvelope(fresh.did, docId, {}))
    expect((r1.body as { entries: string[] }).entries).toHaveLength(1)
    await fresh1.disconnect()

    // A SECOND fresh device (different deviceId) reconstructs identically — the
    // log was not consumed/deleted by serving the first catch-up.
    const fresh2Id = await makeRawIdentity('fresh2b')
    const fresh2 = new TestClient(fresh2Id)
    await fresh2.connect()
    await presentSpaceCapability({ client: fresh2, keypair, spaceId: docId, audience: fresh2Id.did, permissions: ['read'] })
    const r2 = await fresh2.syncRequest(syncRequestEnvelope(fresh2Id.did, docId, {}))
    const entries2 = (r2.body as { entries: string[] }).entries
    expect(entries2).toHaveLength(1)
    expect(await reconstruct(entries2, docId)).toEqual(['persist-0'])
    await fresh2.disconnect()
  })

  it('rejects a divergent entry at an already-used (deviceId,seq) with SEQ_COLLISION_DETECTED and keeps it out of the log', async () => {
    const docId = randomUUID()
    const alice = await makeRawIdentity('alice3')
    const fresh = await makeRawIdentity('fresh3')

    const keypair = await makeSpaceCapabilityKeypair()
    const aliceClient = new TestClient(alice)
    await aliceClient.connect()
    await setupSpace({
      spaceId: docId,
      keypair,
      admin: { client: aliceClient, identity: alice },
      participants: [{ client: aliceClient, identity: alice, permissions: ['write'] }],
    })

    // Accept seq 0.
    const jws0 = await buildLogEntryJws({ identity: alice, docId, seq: 0, plaintext: 'original-0' })
    const ok = await aliceClient.send(logEntryEnvelope(alice.did, [fresh.did], jws0))
    expect((ok as Record<string, unknown>).status).toBe('delivered')

    // Idempotent retransmission of the SAME content → no error, delivered, no dup.
    const again = await aliceClient.send(logEntryEnvelope(alice.did, [fresh.did], jws0))
    expect((again as Record<string, unknown>).status).toBe('delivered')

    // Divergent entry at the SAME (deviceId, seq=0) → reject.
    const jws0b = await buildLogEntryJws({ identity: alice, docId, seq: 0, plaintext: 'DIVERGENT-0' })
    const rejected = await aliceClient.send(logEntryEnvelope(alice.did, [fresh.did], jws0b))
    expect(rejected).toMatchObject({ error: 'SEQ_COLLISION_DETECTED', clientHint: 'restore-clone-required' })

    await aliceClient.disconnect()

    // The divergent entry never reached the durable log: catch-up serves exactly
    // ONE entry, and it is the original content.
    const freshClient = new TestClient(fresh)
    await freshClient.connect()
    await presentSpaceCapability({ client: freshClient, keypair, spaceId: docId, audience: fresh.did, permissions: ['read'] })
    const response = await freshClient.syncRequest(syncRequestEnvelope(fresh.did, docId, {}))
    const body = response.body as { entries: string[] }
    expect(body.entries).toHaveLength(1)
    expect(await reconstruct(body.entries, docId)).toEqual(['original-0'])
    await freshClient.disconnect()
  })

  it('serves an incremental catch-up page when the fresh device already has some heads', async () => {
    const docId = randomUUID()
    const alice = await makeRawIdentity('alice4')
    const fresh = await makeRawIdentity('fresh4')

    const keypair = await makeSpaceCapabilityKeypair()
    const aliceClient = new TestClient(alice)
    await aliceClient.connect()
    await setupSpace({
      spaceId: docId,
      keypair,
      admin: { client: aliceClient, identity: alice },
      participants: [{ client: aliceClient, identity: alice, permissions: ['write'] }],
    })
    const texts = ['c0', 'c1', 'c2']
    for (let seq = 0; seq < texts.length; seq += 1) {
      const jws = await buildLogEntryJws({ identity: alice, docId, seq, plaintext: texts[seq] })
      await aliceClient.send(logEntryEnvelope(alice.did, [fresh.did], jws))
    }
    await aliceClient.disconnect()

    const freshClient = new TestClient(fresh)
    await freshClient.connect()
    await presentSpaceCapability({ client: freshClient, keypair, spaceId: docId, audience: fresh.did, permissions: ['read'] })
    // Already have alice@0 → expect only c1, c2.
    const response = await freshClient.syncRequest(
      syncRequestEnvelope(fresh.did, docId, { [alice.deviceId]: 0 }),
    )
    const body = response.body as { entries: string[]; truncated: boolean }
    expect(body.truncated).toBe(false)
    expect(await reconstruct(body.entries, docId)).toEqual(['c1', 'c2'])
    await freshClient.disconnect()
  })

  it('a durable-log WRITE failure during ingest yields INTERNAL_ERROR to the sender and does not crash the relay', async () => {
    const docId = randomUUID()
    const alice = await makeRawIdentity('alice-dberr')
    const fresh = await makeRawIdentity('fresh-dberr')
    const aliceClient = new TestClient(alice)
    await aliceClient.connect()
    // PERSONAL path (single self-owned writer): present a self-issued write
    // capability for docId so the capability gate passes and we exercise the
    // durable-write failure path, not CAPABILITY_REQUIRED.
    const personalCap = await mintPersonalDocCapability({ owner: alice, docId, permissions: ['read', 'write'] })
    expect(((await aliceClient.presentCapability(personalCap)) as Record<string, unknown>).status).toBe('delivered')

    // Simulate a transient SQLite failure (SQLITE_IOERR / disk-full / closed
    // handle) on the durable write. Before the fix this threw inside a
    // fire-and-forget `void handleLogEntry(...)`, producing an unhandled rejection
    // (process crash on Node 22) and leaving the sender's send() to hang. vitest
    // would also fail the run on the stray unhandled rejection.
    const docLog = (server as unknown as { docLog: { appendEntry: (...a: unknown[]) => void } }).docLog
    const realAppend = docLog.appendEntry.bind(docLog)
    docLog.appendEntry = () => {
      throw new Error('SQLITE_IOERR: simulated disk failure')
    }

    const jws = await buildLogEntryJws({ identity: alice, docId, seq: 0, plaintext: 'will-fail' })
    const outcome = await aliceClient.send(logEntryEnvelope(alice.did, [fresh.did], jws))
    expect(outcome).toMatchObject({ error: 'INTERNAL_ERROR' })

    // The relay is still alive and serving: restore the store, and a subsequent
    // write at the same (deviceId,seq) succeeds (the failed write stored nothing).
    docLog.appendEntry = realAppend
    const jws2 = await buildLogEntryJws({ identity: alice, docId, seq: 0, plaintext: 'recovered-0' })
    const ok = await aliceClient.send(logEntryEnvelope(alice.did, [fresh.did], jws2))
    expect((ok as Record<string, unknown>).status).toBe('delivered')
    await aliceClient.disconnect()
  })

  it('a durable-log READ failure during sync-request yields INTERNAL_ERROR and does not crash the relay', async () => {
    const docId = randomUUID()
    const fresh = await makeRawIdentity('fresh-syncerr')
    const freshClient = new TestClient(fresh)
    await freshClient.connect()
    // PERSONAL path: present a self-issued read capability so sync-request passes the
    // capability gate and reaches the (mocked) durable read.
    const personalCap = await mintPersonalDocCapability({ owner: fresh, docId, permissions: ['read', 'write'] })
    expect(((await freshClient.presentCapability(personalCap)) as Record<string, unknown>).status).toBe('delivered')

    const docLog = (server as unknown as {
      docLog: { getSinceWithTruncation: (...a: unknown[]) => unknown }
    }).docLog
    const realGet = docLog.getSinceWithTruncation.bind(docLog)
    docLog.getSinceWithTruncation = () => {
      throw new Error('SQLITE_IOERR: simulated read failure')
    }

    // sync-request runs through handleSyncRequest synchronously; a throw is caught
    // by the handleMessage safety net and reported as INTERNAL_ERROR, not a crash.
    // Use send() (resolves on receipt OR error) since no sync-response will arrive.
    const outcome = await freshClient.send(syncRequestEnvelope(fresh.did, docId, {}))
    expect(outcome).toMatchObject({ error: 'INTERNAL_ERROR' })

    // Still alive: restore and a real sync-request succeeds (empty doc → no entries).
    docLog.getSinceWithTruncation = realGet
    const response = await freshClient.syncRequest(syncRequestEnvelope(fresh.did, docId, {}))
    expect((response.body as { entries: string[] }).entries).toEqual([])
    await freshClient.disconnect()
  })

  it("device author-binding: a registered device cannot write a log-entry claiming another DID's registered deviceId; cold reconstruction holds only the owner", async () => {
    // Sync 003 §Log-Eintrag-Autor-Bindung against the DURABLE device list: the DID
    // owning payload.deviceId MUST equal the DID in payload.authorKid. Bob is a
    // legitimately registered device (his own deviceId), but he forges a validly
    // BOB-signed entry claiming ALICE's registered deviceId → AUTHOR_MISMATCH. This
    // replaces the Slice-R VE-3a first-writer-wins heuristic.
    const docId = randomUUID()
    const alice = await makeRawIdentity('alice-bind')
    const bob = await makeRawIdentity('bob-bind')
    const fresh = await makeRawIdentity('fresh-bind')

    const aliceClient = new TestClient(alice)
    const bobClient = new TestClient(bob)
    await aliceClient.connect() // registers (alice.did, alice.deviceId)
    await bobClient.connect() // registers (bob.did, bob.deviceId)

    // SPACE path: both producers hold a WRITE capability so the capability gate
    // passes and the AUTHOR_MISMATCH rejection comes from author-binding (the check
    // under test), not from a missing capability.
    const keypair = await makeSpaceCapabilityKeypair()
    await setupSpace({
      spaceId: docId,
      keypair,
      admin: { client: aliceClient, identity: alice },
      participants: [
        { client: aliceClient, identity: alice, permissions: ['write'] },
        { client: bobClient, identity: bob, permissions: ['write'] },
      ],
    })

    // Alice writes seq 0 under her own registered deviceId → accepted.
    const a0 = await buildLogEntryJws({ identity: alice, docId, seq: 0, plaintext: 'alice-0' })
    expect(
      ((await aliceClient.send(logEntryEnvelope(alice.did, [fresh.did], a0))) as Record<string, unknown>).status,
    ).toBe('delivered')

    // Bob signs with his OWN authorKid but claims Alice's REGISTERED deviceId.
    // verifyLogEntryJws passes (valid Bob signature), Bob's socket is active, but
    // didForDevice(alice.deviceId) === alice.did !== bob.did → AUTHOR_MISMATCH for
    // both a new seq and Alice's existing seq 0.
    const bobAtAliceSeq1 = await buildLogEntryJws({ identity: bob, docId, seq: 1, plaintext: 'bob-1', deviceId: alice.deviceId })
    expect(await bobClient.send(logEntryEnvelope(bob.did, [fresh.did], bobAtAliceSeq1))).toMatchObject({ error: 'AUTHOR_MISMATCH' })

    const bobAtAliceSeq0 = await buildLogEntryJws({ identity: bob, docId, seq: 0, plaintext: 'bob-0', deviceId: alice.deviceId })
    expect(await bobClient.send(logEntryEnvelope(bob.did, [fresh.did], bobAtAliceSeq0))).toMatchObject({ error: 'AUTHOR_MISMATCH' })

    await aliceClient.disconnect()
    await bobClient.disconnect()

    // Cold reconstruction contains ONLY Alice's entry — the log was not poisoned.
    const freshClient = new TestClient(fresh)
    await freshClient.connect()
    await presentSpaceCapability({ client: freshClient, keypair, spaceId: docId, audience: fresh.did, permissions: ['read'] })
    const response = await freshClient.syncRequest(syncRequestEnvelope(fresh.did, docId, {}))
    const body = response.body as { entries: string[] }
    expect(body.entries).toHaveLength(1)
    expect(await reconstruct(body.entries, docId)).toEqual(['alice-0'])
    await freshClient.disconnect()
  })

  it('author-binding: a log-entry claiming an UNREGISTERED deviceId is rejected with DEVICE_NOT_REGISTERED', async () => {
    // If payload.deviceId is not in the broker device list at all, author-binding
    // cannot anchor → DEVICE_NOT_REGISTERED; the entry is not stored, not relayed.
    const docId = randomUUID()
    const alice = await makeRawIdentity('alice-unreg')
    const fresh = await makeRawIdentity('fresh-unreg')

    const aliceClient = new TestClient(alice)
    await aliceClient.connect()
    // PERSONAL path: alice holds a write capability for docId so the gate passes and
    // the rejection comes from author-binding (DEVICE_NOT_REGISTERED), the check
    // under test.
    const aliceCap = await mintPersonalDocCapability({ owner: alice, docId, permissions: ['read', 'write'] })
    expect(((await aliceClient.presentCapability(aliceCap)) as Record<string, unknown>).status).toBe('delivered')

    // Alice is registered, but she writes a payload whose deviceId is a brand-new
    // random UUID that was never registered.
    const unregisteredDeviceId = randomUUID()
    const jws = await buildLogEntryJws({ identity: alice, docId, seq: 0, plaintext: 'x', deviceId: unregisteredDeviceId })
    expect(await aliceClient.send(logEntryEnvelope(alice.did, [fresh.did], jws))).toMatchObject({
      error: 'DEVICE_NOT_REGISTERED',
    })
    await aliceClient.disconnect()

    // Nothing was stored — verify from a SECOND client of the SAME owner DID. (A2 Teil B TOFU:
    // a FOREIGN DID is now rejected PERSONAL_DOC_OWNER_MISMATCH on present-capability for an
    // already-claimed personalDocId, so the "nothing stored" check comes from the owner;
    // same-DID multi-device is allowed. The foreign-rejection itself is its own test below.)
    const ownerClient = new TestClient(alice)
    await ownerClient.connect()
    const ownerReadCap = await mintPersonalDocCapability({ owner: alice, docId, permissions: ['read'] })
    expect(((await ownerClient.presentCapability(ownerReadCap)) as Record<string, unknown>).status).toBe('delivered')
    const response = await ownerClient.syncRequest(syncRequestEnvelope(alice.did, docId, {}))
    expect((response.body as { entries: string[] }).entries).toEqual([])
    await ownerClient.disconnect()
  })

  // ── A2 Teil B — Personal-Doc TOFU Owner-Binding (T-CLAIM / T-CHECK / T-SAMEDID) ──

  it('A2 T-CLAIM + T-SAMEDID: owner claims a personal doc on present-capability; a SECOND device of the SAME DID re-claims idempotently, writes, and reads the owner log', async () => {
    const docId = randomUUID()
    const owner = await makeRawIdentity('a2-owner')

    // Device 1: present-capability CLAIMS the personal docId (TOFU), then writes an entry.
    const dev1 = new TestClient(owner)
    await dev1.connect()
    const cap1 = await mintPersonalDocCapability({ owner, docId, permissions: ['read', 'write'] })
    expect(((await dev1.presentCapability(cap1)) as Record<string, unknown>).status).toBe('delivered')
    const jws1 = await buildLogEntryJws({ identity: owner, docId, seq: 0, plaintext: 'bob' })
    expect(((await dev1.send(logEntryEnvelope(owner.did, [owner.did], jws1))) as Record<string, unknown>).status).toBe('delivered')
    await dev1.disconnect()

    // Device 2: SAME DID (shared seed), fresh deviceId. Re-claim is IDEMPOTENT (no conflict);
    // T-SAMEDID lets it read the owner log + write under its own (deviceId,seq) namespace.
    const ownerDev2 = { ...owner, deviceId: randomUUID() }
    const dev2 = new TestClient(ownerDev2)
    await dev2.connect()
    const cap2 = await mintPersonalDocCapability({ owner, docId, permissions: ['read', 'write'] })
    expect(((await dev2.presentCapability(cap2)) as Record<string, unknown>).status).toBe('delivered')
    const resp = await dev2.syncRequest(syncRequestEnvelope(owner.did, docId, {}))
    expect((resp.body as { entries: string[] }).entries).toHaveLength(1)
    const jws2 = await buildLogEntryJws({ identity: ownerDev2, docId, seq: 0, plaintext: 'from-dev2' })
    expect(((await dev2.send(logEntryEnvelope(owner.did, [owner.did], jws2))) as Record<string, unknown>).status).toBe('delivered')
    await dev2.disconnect()
  })

  it('A2 T-CLAIM conflict: a FOREIGN DID presenting a capability for an already-claimed personal doc is rejected PERSONAL_DOC_OWNER_MISMATCH (no scope, no receipt)', async () => {
    const docId = randomUUID()
    const owner = await makeRawIdentity('a2-claim-owner')
    const foreigner = await makeRawIdentity('a2-claim-foreign')

    const ownerClient = new TestClient(owner)
    await ownerClient.connect()
    const ownerCap = await mintPersonalDocCapability({ owner, docId, permissions: ['read', 'write'] })
    expect(((await ownerClient.presentCapability(ownerCap)) as Record<string, unknown>).status).toBe('delivered')

    // The foreigner LEARNED the (seed-secret) docId and self-issues a valid capability for it.
    // TOFU binds the doc to the owner, so the foreigner's present-capability is rejected.
    const foreignClient = new TestClient(foreigner)
    await foreignClient.connect()
    const foreignCap = await mintPersonalDocCapability({ owner: foreigner, docId, permissions: ['read', 'write'] })
    expect(await foreignClient.presentCapability(foreignCap)).toMatchObject({ error: 'PERSONAL_DOC_OWNER_MISMATCH' })

    await ownerClient.disconnect()
    await foreignClient.disconnect()
  })

  it('A2 T-CHECK write+read: a FOREIGN DID is rejected PERSONAL_DOC_OWNER_MISMATCH on log-entry AND sync-request (owner gate BEFORE the scope cache — not CAPABILITY_REQUIRED)', async () => {
    const docId = randomUUID()
    const owner = await makeRawIdentity('a2-check-owner')
    const foreigner = await makeRawIdentity('a2-check-foreign')

    // Owner claims the doc.
    const ownerClient = new TestClient(owner)
    await ownerClient.connect()
    const ownerCap = await mintPersonalDocCapability({ owner, docId, permissions: ['read', 'write'] })
    expect(((await ownerClient.presentCapability(ownerCap)) as Record<string, unknown>).status).toBe('delivered')

    // The foreigner connects but presents NO capability (it has no scope). Its write + read
    // still hit PERSONAL_DOC_OWNER_MISMATCH — proving the owner gate runs BEFORE the scope
    // cache (else an unscoped foreigner would get CAPABILITY_REQUIRED instead).
    const foreignClient = new TestClient(foreigner)
    await foreignClient.connect()
    const foreignJws = await buildLogEntryJws({ identity: foreigner, docId, seq: 0, plaintext: 'poison' })
    expect(await foreignClient.send(logEntryEnvelope(foreigner.did, [owner.did], foreignJws))).toMatchObject({
      error: 'PERSONAL_DOC_OWNER_MISMATCH',
    })
    // Read gate: a foreign sync-request gets the error frame (captured via send, not syncRequest).
    expect(await foreignClient.send(syncRequestEnvelope(foreigner.did, docId, {}))).toMatchObject({
      error: 'PERSONAL_DOC_OWNER_MISMATCH',
    })

    // The owner's write still works (the gate only blocks foreigners).
    const ownerJws = await buildLogEntryJws({ identity: owner, docId, seq: 0, plaintext: 'ok' })
    expect(((await ownerClient.send(logEntryEnvelope(owner.did, [owner.did], ownerJws))) as Record<string, unknown>).status).toBe('delivered')

    await ownerClient.disconnect()
    await foreignClient.disconnect()
  })

  it('A2 anti-escalation: a FOREIGN DID cannot space-register a personally-owned docId to escape the owner gate — neither as sole admin NOR with the owner as a decoy co-admin (#224); the owner keeps exclusive access', async () => {
    const docId = randomUUID()
    const owner = await makeRawIdentity('a2-esc-owner')
    const foreigner = await makeRawIdentity('a2-esc-foreign')

    // Owner claims the personal doc + writes a (decryptable-only-by-owner) entry.
    const ownerClient = new TestClient(owner)
    await ownerClient.connect()
    const ownerCap = await mintPersonalDocCapability({ owner, docId, permissions: ['read', 'write'] })
    expect(((await ownerClient.presentCapability(ownerCap)) as Record<string, unknown>).status).toBe('delivered')
    const jws = await buildLogEntryJws({ identity: owner, docId, seq: 0, plaintext: 'secret' })
    expect(((await ownerClient.send(logEntryEnvelope(owner.did, [owner.did], jws))) as Record<string, unknown>).status).toBe('delivered')

    // Foreigner learned the bearer-secret docId and tries to HIJACK it by promoting it to a
    // space with itself as the sole admin — the escalation that bypasses the personal gate.
    const foreignClient = new TestClient(foreigner)
    await foreignClient.connect()
    const keypair = await makeSpaceCapabilityKeypair()
    expect(
      await foreignClient.sendSpaceRegister({
        signer: foreigner,
        spaceId: docId,
        spaceCapabilityVerificationKey: keypair.verificationKey,
        adminDids: [foreigner.did],
      }),
    ).toMatchObject({ error: 'PERSONAL_DOC_OWNER_MISMATCH' })

    // DECOY-CO-ADMIN VARIANT (the #224 hardening, over the REAL wire): the foreigner lists the
    // OWNER as a co-admin and SIGNS AS THEMSELVES. An owner∈adminDids check would WRONGLY pass;
    // binding on the cryptographically-proven inner-JWS signer (foreigner != owner) still rejects
    // it. This exercises the full path verifySpaceRegisterMessage → header.kid → didOrKidToDid →
    // registerSpace({ signerDid }), which the DocLog store-level test cannot.
    expect(
      await foreignClient.sendSpaceRegister({
        signer: foreigner,
        spaceId: docId,
        spaceCapabilityVerificationKey: keypair.verificationKey,
        adminDids: [foreigner.did, owner.did],
      }),
    ).toMatchObject({ error: 'PERSONAL_DOC_OWNER_MISMATCH' })

    // The doc stays PERSONAL (never space-registered by either attempt): the owner still reads
    // their entry; the foreigner still cannot.
    const resp = await ownerClient.syncRequest(syncRequestEnvelope(owner.did, docId, {}))
    expect((resp.body as { entries: string[] }).entries).toHaveLength(1)
    expect(await foreignClient.send(syncRequestEnvelope(foreigner.did, docId, {}))).toMatchObject({
      error: 'PERSONAL_DOC_OWNER_MISMATCH',
    })

    await ownerClient.disconnect()
    await foreignClient.disconnect()
  })

  it('A2 anti-escalation: the OWNER may upgrade their OWN personal doc to a space (owner ∈ adminDids); the personal binding is then cleared', async () => {
    const docId = randomUUID()
    const owner = await makeRawIdentity('a2-upgrade-owner')

    const ownerClient = new TestClient(owner)
    await ownerClient.connect()
    const ownerCap = await mintPersonalDocCapability({ owner, docId, permissions: ['read', 'write'] })
    expect(((await ownerClient.presentCapability(ownerCap)) as Record<string, unknown>).status).toBe('delivered')

    // The owner promotes their own doc to a space (their DID is the admin) → allowed.
    const keypair = await makeSpaceCapabilityKeypair()
    expect(
      ((await ownerClient.sendSpaceRegister({
        signer: owner,
        spaceId: docId,
        spaceCapabilityVerificationKey: keypair.verificationKey,
        adminDids: [owner.did],
      })) as Record<string, unknown>).status,
    ).toBe('delivered')

    // The docId is now a SPACE and NO LONGER personal-owned (never both).
    const docLog = (server as unknown as {
      docLog: { isPersonalDocOwned: (d: string) => boolean; isSpaceRegistered: (d: string) => boolean }
    }).docLog
    expect(docLog.isSpaceRegistered(docId)).toBe(true)
    expect(docLog.isPersonalDocOwned(docId)).toBe(false)

    await ownerClient.disconnect()
  })

  it('VE-1: two DIFFERENT DIDs cannot register the SAME deviceId — the second gets DEVICE_ID_CONFLICT (globally unique)', async () => {
    // Sync 003 §Erstregistrierung: deviceId is globally unique. Bob authenticates
    // successfully but reuses Alice's already-registered deviceId → registration is
    // refused with DEVICE_ID_CONFLICT and Bob's connection is NOT registered (no
    // `registered` frame).
    const alice = await makeRawIdentity('alice-conflict')
    const bobBase = await makeRawIdentity('bob-conflict')
    // Bob shares Alice's deviceId but has his own DID/seed.
    const bob: RawIdentity = { ...bobBase, deviceId: alice.deviceId }

    const aliceClient = new TestClient(alice)
    await aliceClient.connect()

    // Bob's connect() awaits a `registered` frame; with a conflict the relay sends
    // an `error` instead, so connect() never resolves. Drive the handshake manually
    // and assert the error frame.
    const outcome = await connectExpectingError(bob)
    expect(outcome.code).toBe('DEVICE_ID_CONFLICT')

    await aliceClient.disconnect()
  })

  it('VE-2: a device revoked DURING an open session is rejected on the next log-entry AND sync-request with DEVICE_REVOKED', async () => {
    // Live status check (not just authorKid DID-equality): Alice is connected and
    // active, then a signed device-revoke for (alice.did, alice.deviceId) arrives.
    // The durable device row flips to revoked; Alice's still-open socket must now be
    // rejected on both ingest paths even though her authorKid DID still matches.
    const docId = randomUUID()
    const alice = await makeRawIdentity('alice-revoke')
    const fresh = await makeRawIdentity('fresh-revoke')

    const keypair = await makeSpaceCapabilityKeypair()
    const aliceClient = new TestClient(alice)
    await aliceClient.connect()
    // SPACE path: alice holds read+write so the post-revoke rejections are
    // unambiguously the live device-active check (DEVICE_REVOKED), not a missing
    // capability. The device-active check runs BEFORE the gate on log-entry, and
    // before the read gate on sync-request — a revoked device is rejected regardless.
    await setupSpace({
      spaceId: docId,
      keypair,
      admin: { client: aliceClient, identity: alice },
      participants: [{ client: aliceClient, identity: alice, permissions: ['read', 'write'] }],
    })

    // A first write succeeds while active.
    const a0 = await buildLogEntryJws({ identity: alice, docId, seq: 0, plaintext: 'before-revoke' })
    expect(((await aliceClient.send(logEntryEnvelope(alice.did, [fresh.did], a0))) as Record<string, unknown>).status).toBe('delivered')

    // Revoke alice's device via a signed device-revoke control-frame (inner JWS
    // signed by alice's Identity Key). Sent over a SEPARATE admin socket — any
    // valid signature by the DID's key may revoke (Shared-Seed model).
    const revoke = await buildDeviceRevokeFrame(alice, alice.deviceId, '2026-06-22T10:00:00Z')
    const admin = await makeRawIdentity('admin-revoke')
    const adminClient = new TestClient(admin)
    await adminClient.connect()
    const revokeOutcome = await adminClient.sendControlFrame(revoke)
    expect((revokeOutcome as Record<string, unknown>).status).toBe('delivered')
    await adminClient.disconnect()

    // Alice's SAME open socket: next log-entry → DEVICE_REVOKED.
    const a1 = await buildLogEntryJws({ identity: alice, docId, seq: 1, plaintext: 'after-revoke' })
    expect(await aliceClient.send(logEntryEnvelope(alice.did, [fresh.did], a1))).toMatchObject({ error: 'DEVICE_REVOKED' })

    // Alice's SAME open socket: sync-request → DEVICE_REVOKED.
    expect(await aliceClient.send(syncRequestEnvelope(alice.did, docId, {}))).toMatchObject({ error: 'DEVICE_REVOKED' })
    await aliceClient.disconnect()

    // The post-revoke entry was never stored: cold reconstruction holds only seq 0.
    const freshClient = new TestClient(fresh)
    await freshClient.connect()
    await presentSpaceCapability({ client: freshClient, keypair, spaceId: docId, audience: fresh.did, permissions: ['read'] })
    const response = await freshClient.syncRequest(syncRequestEnvelope(fresh.did, docId, {}))
    const body = response.body as { entries: string[] }
    expect(body.entries).toHaveLength(1)
    expect(await reconstruct(body.entries, docId)).toEqual(['before-revoke'])
    await freshClient.disconnect()
  })

  it('device-revoke: a malformed control-frame (extra top-level field) is rejected with MALFORMED_MESSAGE', async () => {
    const alice = await makeRawIdentity('alice-revoke-malformed')
    const peer = await makeRawIdentity('peer-revoke-malformed')
    const aliceClient = new TestClient(alice)
    await aliceClient.connect()

    const valid = await buildDeviceRevokeFrame(alice, alice.deviceId, '2026-06-22T10:00:00Z')
    // Add a forbidden top-level field — the outer frame MUST carry exactly
    // {type, revocationJws} (Sync 003 §Device-Deaktivierung).
    const malformed = { ...valid, thid: randomUUID() }
    expect(await aliceClient.sendControlFrame(malformed)).toMatchObject({ error: 'MALFORMED_MESSAGE' })

    // The device is still active (the malformed frame had no effect). Present a
    // self-issued write capability (PERSONAL path) so the write reaches the
    // device-active check instead of CAPABILITY_REQUIRED.
    const docId = randomUUID()
    const cap = await mintPersonalDocCapability({ owner: alice, docId, permissions: ['read', 'write'] })
    expect(((await aliceClient.presentCapability(cap)) as Record<string, unknown>).status).toBe('delivered')
    const jws = await buildLogEntryJws({ identity: alice, docId, seq: 0, plaintext: 'still-active' })
    expect(((await aliceClient.send(logEntryEnvelope(alice.did, [peer.did], jws))) as Record<string, unknown>).status).toBe('delivered')
    await aliceClient.disconnect()
  })

  it('device-revoke: a frame whose inner JWS is signed by a DIFFERENT key is rejected with AUTH_INVALID', async () => {
    const alice = await makeRawIdentity('alice-revoke-badsig')
    const mallory = await makeRawIdentity('mallory-revoke-badsig')
    const peer = await makeRawIdentity('peer-revoke-badsig')
    const aliceClient = new TestClient(alice)
    await aliceClient.connect()

    // Inner payload claims alice's DID, but the JWS is signed with mallory's seed
    // while the header kid still says alice (so didOrKidToDid(kid) === payload.did
    // passes the header check, but the Ed25519 verification against alice's key
    // fails) → AUTH_INVALID.
    const payload = { type: 'device-revoke', did: alice.did, deviceId: alice.deviceId, revokedAt: '2026-06-22T10:00:00Z' }
    const forgedJws = await protocol.createJcsEd25519Jws(
      { alg: 'EdDSA', kid: alice.authorKid },
      payload as unknown as protocol.JsonValue,
      mallory.seed,
    )
    const frame = { type: 'device-revoke', revocationJws: forgedJws }
    expect(await aliceClient.sendControlFrame(frame)).toMatchObject({ error: 'AUTH_INVALID' })

    // alice's device is untouched: still active. Present a self-issued write
    // capability (PERSONAL path) so the write is gated-through to the device-active
    // check.
    const docId = randomUUID()
    const cap = await mintPersonalDocCapability({ owner: alice, docId, permissions: ['read', 'write'] })
    expect(((await aliceClient.presentCapability(cap)) as Record<string, unknown>).status).toBe('delivered')
    const jws = await buildLogEntryJws({ identity: alice, docId, seq: 0, plaintext: 'untouched' })
    expect(((await aliceClient.send(logEntryEnvelope(alice.did, [peer.did], jws))) as Record<string, unknown>).status).toBe('delivered')
    await aliceClient.disconnect()
  })

  it('Sync 003: the same payload re-encoded into a DIFFERENT JWS envelope dedups (content-hash over payload, not JWS)', async () => {
    const docId = randomUUID()
    const alice = await makeRawIdentity('alice-payloadhash')
    const fresh = await makeRawIdentity('fresh-payloadhash')
    const keypair = await makeSpaceCapabilityKeypair()
    const aliceClient = new TestClient(alice)
    await aliceClient.connect()
    await setupSpace({
      spaceId: docId,
      keypair,
      admin: { client: aliceClient, identity: alice },
      participants: [{ client: aliceClient, identity: alice, permissions: ['write'] }],
    })

    // One log-entry PAYLOAD, two valid JWS encodings: jws1 via createLogEntryJws
    // ({alg,kid}); jws2 via createJcsEd25519Jws with an extra `typ` header field.
    // Both pass verifyLogEntryJws (deviceId/seq/authorKid identical), so the broker
    // must dedup them as one entry — not flag SEQ_COLLISION_DETECTED.
    const spaceContentKey = await deriveSpaceContentKey(docId, 0)
    const enc = await protocol.encryptLogPayload({
      crypto: cryptoAdapter,
      spaceContentKey,
      deviceId: alice.deviceId,
      seq: 0,
      plaintext: new TextEncoder().encode('same-payload'),
    })
    const payload = {
      seq: 0,
      deviceId: alice.deviceId,
      docId,
      authorKid: alice.authorKid,
      keyGeneration: 0,
      data: enc.blobBase64Url,
      timestamp: FIXED_TIMESTAMP,
    }
    const jws1 = await protocol.createLogEntryJws({ payload, signingSeed: alice.seed })
    const jws2 = await protocol.createJcsEd25519Jws(
      { alg: 'EdDSA', kid: alice.authorKid, typ: 'JWT' },
      payload as unknown as protocol.JsonValue,
      alice.seed,
    )
    expect(jws1).not.toBe(jws2)

    expect(((await aliceClient.send(logEntryEnvelope(alice.did, [fresh.did], jws1))) as Record<string, unknown>).status).toBe('delivered')
    // Same payload, different envelope → idempotent, NOT SEQ_COLLISION_DETECTED.
    expect(((await aliceClient.send(logEntryEnvelope(alice.did, [fresh.did], jws2))) as Record<string, unknown>).status).toBe('delivered')
    await aliceClient.disconnect()

    const freshClient = new TestClient(fresh)
    await freshClient.connect()
    await presentSpaceCapability({ client: freshClient, keypair, spaceId: docId, audience: fresh.did, permissions: ['read'] })
    const resp = await freshClient.syncRequest(syncRequestEnvelope(fresh.did, docId, {}))
    expect((resp.body as { entries: string[] }).entries).toHaveLength(1)
    await freshClient.disconnect()
  })

  it('Sync 003: sync-request without limit caps at the spec default of 100 and reports truncated', async () => {
    const docId = randomUUID()
    const alice = await makeRawIdentity('alice-limit')
    const fresh = await makeRawIdentity('fresh-limit')

    // Seed 101 entries straight into the durable log (the limit logic under test is
    // in handleSyncRequest, not the ingest path — direct seeding keeps it fast).
    const docLog = (server as unknown as {
      docLog: {
        appendEntry: (p: Record<string, unknown>) => { disposition: string }
        hashPayload: (p: unknown) => Promise<string>
      }
    }).docLog
    const spaceContentKey = await deriveSpaceContentKey(docId, 0)
    for (let seq = 0; seq <= 100; seq += 1) {
      const enc = await protocol.encryptLogPayload({
        crypto: cryptoAdapter,
        spaceContentKey,
        deviceId: alice.deviceId,
        seq,
        plaintext: new TextEncoder().encode(`e${seq}`),
      })
      const payload = {
        seq,
        deviceId: alice.deviceId,
        docId,
        authorKid: alice.authorKid,
        keyGeneration: 0,
        data: enc.blobBase64Url,
        timestamp: FIXED_TIMESTAMP,
      }
      const jws = await protocol.createLogEntryJws({ payload, signingSeed: alice.seed })
      const r = docLog.appendEntry({
        docId,
        deviceId: alice.deviceId,
        seq,
        contentHash: await docLog.hashPayload(payload),
        entryJws: jws,
      })
      expect(r.disposition).toBe('accept-new-entry')
    }

    const freshClient = new TestClient(fresh)
    await freshClient.connect()
    // PERSONAL path: the docId was never space-registered (entries were seeded
    // directly), so a self-issued read capability gates the sync-request through.
    const freshCap = await mintPersonalDocCapability({ owner: fresh, docId, permissions: ['read'] })
    expect(((await freshClient.presentCapability(freshCap)) as Record<string, unknown>).status).toBe('delivered')
    // No `limit` in the request → relay applies the spec default of 100.
    const resp = await freshClient.syncRequest(syncRequestEnvelope(fresh.did, docId, {}))
    const body = resp.body as { entries: string[]; truncated: boolean }
    expect(body.entries).toHaveLength(100)
    expect(body.truncated).toBe(true)
    await freshClient.disconnect()
  })

  it("BLOCKER 1 — a device-revoke whose payload.did != the deviceId's registered owner is AUTH_INVALID and leaves the victim device active", async () => {
    // Authorization boundary (Sync 003 §Device-Deaktivierung): a device-revoke may
    // only revoke a device OWNED by the signing DID. The inner JWS is signed by
    // payload.did, but payload.did is attacker-chosen. Here Mallory signs a perfectly
    // valid revoke for {did: mallory.did, deviceId: VICTIM's deviceId}. Without the
    // owner check the broker would flip the victim's ACTIVE device to revoked
    // (cross-DID revocation). The fix: the durable row for the deviceId is owned by
    // the victim, not Mallory → 'did-mismatch' → AUTH_INVALID, no state change.
    const docId = randomUUID()
    const victim = await makeRawIdentity('b1-victim')
    const mallory = await makeRawIdentity('b1-mallory')
    const fresh = await makeRawIdentity('b1-fresh')

    const keypair = await makeSpaceCapabilityKeypair()
    const victimClient = new TestClient(victim)
    const malloryClient = new TestClient(mallory)
    await victimClient.connect() // registers (victim.did, victim.deviceId) as active
    await malloryClient.connect()

    // SPACE setup so the victim can write (read+write) — proves the device stays
    // usable after the rejected cross-DID revoke (not just that the row is unchanged).
    await setupSpace({
      spaceId: docId,
      keypair,
      admin: { client: victimClient, identity: victim },
      participants: [{ client: victimClient, identity: victim, permissions: ['read', 'write'] }],
    })

    // The victim writes seq 0 while active (baseline).
    const v0 = await buildLogEntryJws({ identity: victim, docId, seq: 0, plaintext: 'victim-before' })
    expect(((await victimClient.send(logEntryEnvelope(victim.did, [fresh.did], v0))) as Record<string, unknown>).status).toBe('delivered')

    // Mallory signs a VALID revoke for her OWN did but the VICTIM's deviceId.
    // The JWS verifies (signed by mallory's key, kid-DID == payload.did == mallory),
    // so this is NOT a signature failure — it is the cross-DID authorization breach.
    const crossDidRevoke = await buildDeviceRevokeFrame(mallory, victim.deviceId, '2026-06-23T10:00:00Z')
    expect(await malloryClient.sendControlFrame(crossDidRevoke)).toMatchObject({ error: 'AUTH_INVALID' })

    // The victim's device is STILL active: her next write on the SAME open socket
    // succeeds (NOT DEVICE_REVOKED). The cross-DID revoke had no effect.
    const v1 = await buildLogEntryJws({ identity: victim, docId, seq: 1, plaintext: 'victim-after' })
    expect(((await victimClient.send(logEntryEnvelope(victim.did, [fresh.did], v1))) as Record<string, unknown>).status).toBe('delivered')

    // And the durable device row is unchanged (still owned by victim, still active).
    const docLog = (server as unknown as {
      docLog: { getDevice: (id: string) => { did: string; status: string } | null }
    }).docLog
    expect(docLog.getDevice(victim.deviceId)).toMatchObject({ did: victim.did, status: 'active' })

    await victimClient.disconnect()
    await malloryClient.disconnect()
  })

  it('SHOULD-FIX 2 — a socket revoked mid-session sending a log-entry WITHOUT a presented scope is DEVICE_REVOKED, not CAPABILITY_REQUIRED', async () => {
    // The live revoked check MUST run on every log-entry BEFORE the capability gate
    // (Sync 003 — sync-request already does this). A revoked socket with no cached
    // scope must report DEVICE_REVOKED (the higher-priority signal), not the generic
    // CAPABILITY_REQUIRED. Alice NEVER presents a capability here, so before the
    // reorder she would have hit CAPABILITY_REQUIRED.
    const docId = randomUUID()
    const alice = await makeRawIdentity('sf2-alice')
    const fresh = await makeRawIdentity('sf2-fresh')

    const aliceClient = new TestClient(alice)
    await aliceClient.connect() // active, NO present-capability

    // Revoke alice's own device mid-session (signed by alice's Identity Key — a
    // self-revoke, which is authorized; cross-DID is covered by BLOCKER 1).
    const revoke = await buildDeviceRevokeFrame(alice, alice.deviceId, '2026-06-23T10:00:00Z')
    const admin = await makeRawIdentity('sf2-admin')
    const adminClient = new TestClient(admin)
    await adminClient.connect()
    expect((await adminClient.sendControlFrame(revoke) as Record<string, unknown>).status).toBe('delivered')
    await adminClient.disconnect()

    // Alice's next log-entry on the SAME open socket, with NO scope presented →
    // DEVICE_REVOKED (device-active runs before the gate), NOT CAPABILITY_REQUIRED.
    const a0 = await buildLogEntryJws({ identity: alice, docId, seq: 0, plaintext: 'after-revoke-no-scope' })
    expect(await aliceClient.send(logEntryEnvelope(alice.did, [fresh.did], a0))).toMatchObject({ error: 'DEVICE_REVOKED' })

    await aliceClient.disconnect()
  })

  it('SHOULD-FIX 1 — an async control-frame handler that throws yields INTERNAL_ERROR to the sender and does not crash the relay', async () => {
    // device-revoke / space-register / space-rotate / admin-* / present-capability are
    // dispatched as `this.handleX(...).catch(sendInternalError)` (NOT bare `void`), so
    // a later promise rejection on an unexpected SQLite/crypto error surfaces as an
    // INTERNAL_ERROR frame rather than an unhandled rejection (process crash on Node
    // 22 / vitest run failure). Force handleSpaceRegister's durable write to throw.
    const docId = randomUUID()
    const admin = await makeRawIdentity('sf1-admin')
    const adminClient = new TestClient(admin)
    await adminClient.connect()

    const keypair = await makeSpaceCapabilityKeypair()
    const docLog = (server as unknown as { docLog: { registerSpace: (...a: unknown[]) => unknown } }).docLog
    const realRegisterSpace = docLog.registerSpace.bind(docLog)
    docLog.registerSpace = () => {
      throw new Error('SQLITE_IOERR: simulated registry write failure')
    }

    // The throw happens in the async tail of handleSpaceRegister; the `.catch()` at
    // the dispatch site reports INTERNAL_ERROR instead of crashing.
    const outcome = await adminClient.sendSpaceRegister({
      signer: admin,
      spaceId: docId,
      spaceCapabilityVerificationKey: keypair.verificationKey,
      adminDids: [admin.did],
    })
    expect(outcome).toMatchObject({ error: 'INTERNAL_ERROR' })

    // The relay is still alive and serving: restore the store, and a real
    // space-register now succeeds.
    docLog.registerSpace = realRegisterSpace
    const ok = await adminClient.sendSpaceRegister({
      signer: admin,
      spaceId: docId,
      spaceCapabilityVerificationKey: keypair.verificationKey,
      adminDids: [admin.did],
    })
    expect((ok as Record<string, unknown>).status).toBe('delivered')

    await adminClient.disconnect()
  })
})
