import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { randomUUID, randomBytes } from 'crypto'
import WebSocket from 'ws'
import { RelayServer } from '../src/relay.js'
import type { RelayMessage } from '../src/types.js'
import { protocol, WebCryptoProtocolCryptoAdapter } from '@web_of_trust/core'

// Slice CG / Phase 4 (VE-4 + VE-5 + VE-8) — the broker capability gate on the
// REAL relay. After a session-scoped `present-capability`, `log-entry` ingest
// requires a cached WRITE scope and `sync-request` a cached READ scope for the
// docId (Sync 003 §Capability-Prüfung + §Gate). The Inbox channel stays UNGATED
// (Cold-Start). VE-8: the initial `space-register` for a docId drops any cached
// Personal-Doc scope for it across all open sockets.

const PORT = 9889
const RELAY_URL = `ws://localhost:${PORT}`
const CAP_ISSUED_AT = '2026-01-01T00:00:00Z'
const CAP_VALID_UNTIL = '2099-01-01T00:00:00Z'

const cryptoAdapter = new WebCryptoProtocolCryptoAdapter()
const {
  buildBrokerAuthTranscript,
  createBrokerAuthTranscriptSigningBytes,
  formatBrokerChallengeResponseSignature,
  DIDCOMM_PLAINTEXT_TYP,
  SPACE_INVITE_MESSAGE_TYPE,
} = protocol

// --- raw-seed identity --------------------------------------------------------

interface RawIdentity {
  seed: Uint8Array
  did: string
  authorKid: string
  deviceId: string
  signTranscriptBytes: (bytes: Uint8Array) => Promise<Uint8Array>
}

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
  const seed = await cryptoAdapter.sha256(new TextEncoder().encode(`capability-gate-test/seed/${label}`))
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

// --- Space Capability keypair (Sync 003 §Capability-Format) -------------------

interface SpaceCapabilityKeypair {
  signingSeed: Uint8Array
  verificationKey: string
}

async function makeSpaceCapabilityKeypair(): Promise<SpaceCapabilityKeypair> {
  const signingSeed = new Uint8Array(randomBytes(32))
  const pub = await cryptoAdapter.ed25519PublicKeyFromSeed(signingSeed)
  return { signingSeed, verificationKey: protocol.encodeBase64Url(pub) }
}

async function mintSpaceCapability(params: {
  keypair: SpaceCapabilityKeypair
  spaceId: string
  audience: string
  permissions: Array<'read' | 'write'>
  generation?: number
  validUntil?: string
}): Promise<string> {
  return protocol.createSpaceCapabilityJws({
    payload: {
      type: 'capability',
      spaceId: params.spaceId,
      audience: params.audience,
      permissions: params.permissions,
      generation: params.generation ?? 0,
      issuedAt: CAP_ISSUED_AT,
      validUntil: params.validUntil ?? CAP_VALID_UNTIL,
    },
    signingSeed: params.keypair.signingSeed,
  })
}

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

// --- log-entry / sync-request envelope builders ------------------------------

async function buildLogEntryJws(params: {
  identity: RawIdentity
  docId: string
  seq: number
  plaintext: string
  // Defaults to 0. After a space-rotate to gen N a legitimate write MUST carry the
  // new keyGeneration (and is encrypted under the matching content key), else the
  // VE-R1 Broker-Ingest-Generations-Gate rejects it KEY_GENERATION_STALE.
  keyGeneration?: number
}): Promise<string> {
  const generation = params.keyGeneration ?? 0
  const spaceContentKey = await deriveSpaceContentKey(params.docId, generation)
  const enc = await protocol.encryptLogPayload({
    crypto: cryptoAdapter,
    spaceContentKey,
    deviceId: params.identity.deviceId,
    seq: params.seq,
    plaintext: new TextEncoder().encode(params.plaintext),
  })
  const payload = {
    seq: params.seq,
    deviceId: params.identity.deviceId,
    docId: params.docId,
    authorKid: params.identity.authorKid,
    keyGeneration: generation,
    data: enc.blobBase64Url,
    timestamp: '2026-06-22T10:00:00Z',
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

function syncRequestEnvelope(from: string, docId: string, heads: Record<string, number>): Record<string, unknown> {
  return protocol.createSyncRequestMessage({
    id: randomUUID(),
    from,
    createdTime: Math.floor(Date.now() / 1000),
    body: { docId, heads },
  }) as unknown as Record<string, unknown>
}

// --- minimal authenticated relay client over ws ------------------------------

type SendOutcome = Record<string, unknown> | { error: string; clientHint?: string }

class TestClient {
  private ws: WebSocket | null = null
  /** Inbound `message` envelopes not yet consumed by a waiter (buffered for nextMessage). */
  private messageBuffer: Record<string, unknown>[] = []
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
            const waiter = this.messageWaiters.shift()
            if (waiter) waiter(msg.envelope)
            else this.messageBuffer.push(msg.envelope)
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

  /** Send a RAW top-level control frame; resolves on receipt OR error. */
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

  /** Present a capability for a docId; resolves on receipt OR error. */
  presentCapability(capabilityJws: string): Promise<SendOutcome> {
    return this.sendControlFrame({ type: 'present-capability', capabilityJws })
  }

  /** Send a present-capability frame WITHOUT awaiting registration first. */
  presentCapabilityRaw(capabilityJws: string): void {
    this.ws!.send(JSON.stringify({ type: 'present-capability', capabilityJws }))
  }

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

  async sendSpaceRotate(params: {
    signer: RawIdentity
    spaceId: string
    newSpaceCapabilityVerificationKey: string
    newGeneration: number
  }): Promise<SendOutcome> {
    const frame = await protocol.createSpaceRotateMessage({
      spaceId: params.spaceId,
      newSpaceCapabilityVerificationKey: params.newSpaceCapabilityVerificationKey,
      newGeneration: params.newGeneration,
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

  /** Wait for the next inbound `message` envelope (e.g. a queued inbox delivery). */
  nextMessage(): Promise<Record<string, unknown>> {
    const buffered = this.messageBuffer.shift()
    if (buffered) return Promise.resolve(buffered)
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Timeout waiting for inbound message')), 2000)
      this.messageWaiters.push((env) => {
        clearTimeout(timer)
        resolve(env)
      })
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

/** Reach into the server's durable space registry to inspect it (test-only). */
function docLogOf(server: RelayServer): {
  isSpaceRegistered: (id: string) => boolean
  getSpace: (id: string) => { verificationKey: string; generation: number } | null
} {
  const internal = server as unknown as {
    docLog: {
      isSpaceRegistered: (id: string) => boolean
      getSpace: (id: string) => { verificationKey: string; generation: number } | null
    }
  }
  return {
    isSpaceRegistered: (id) => internal.docLog.isSpaceRegistered(id),
    getSpace: (id) => internal.docLog.getSpace(id),
  }
}

describe('Broker capability gate over the real relay (Slice CG / VE-4 + VE-5 + VE-8)', () => {
  let server: RelayServer

  beforeEach(async () => {
    server = new RelayServer({ port: PORT })
    await server.start()
  })

  afterEach(async () => {
    await server.stop()
  })

  it('present-capability (SPACE path): a verified read+write capability enables both log-entry and sync-request', async () => {
    const docId = randomUUID()
    const alice = await makeRawIdentity('space-rw')
    const keypair = await makeSpaceCapabilityKeypair()
    const client = new TestClient(alice)
    await client.connect()

    // Register the space (alice = admin), then present a read+write capability.
    expect(
      (
        (await client.sendSpaceRegister({
          signer: alice,
          spaceId: docId,
          spaceCapabilityVerificationKey: keypair.verificationKey,
          adminDids: [alice.did],
        })) as Record<string, unknown>
      ).status,
    ).toBe('delivered')
    const cap = await mintSpaceCapability({ keypair, spaceId: docId, audience: alice.did, permissions: ['read', 'write'] })
    expect(((await client.presentCapability(cap)) as Record<string, unknown>).status).toBe('delivered')

    // WRITE enabled: log-entry stored.
    const jws = await buildLogEntryJws({ identity: alice, docId, seq: 0, plaintext: 'cap-ok' })
    expect(((await client.send(logEntryEnvelope(alice.did, [alice.did], jws))) as Record<string, unknown>).status).toBe('delivered')

    // READ enabled: sync-request served.
    const resp = await client.syncRequest(syncRequestEnvelope(alice.did, docId, {}))
    expect(resp.type).toBe(protocol.SYNC_RESPONSE_MESSAGE_TYPE)
    expect((resp.body as { entries: string[] }).entries).toHaveLength(1)

    await client.disconnect()
  })

  it('present-capability (PERSONAL path): a self-issued capability for an unregistered docId enables write + read', async () => {
    const docId = randomUUID()
    const owner = await makeRawIdentity('personal-rw')
    const client = new TestClient(owner)
    await client.connect()

    // No space-register for docId → PERSONAL path. Self-issued (kid-DID = audience =
    // authenticated DID), generation 0.
    const cap = await mintPersonalDocCapability({ owner, docId, permissions: ['read', 'write'] })
    expect(((await client.presentCapability(cap)) as Record<string, unknown>).status).toBe('delivered')

    const jws = await buildLogEntryJws({ identity: owner, docId, seq: 0, plaintext: 'personal-ok' })
    expect(((await client.send(logEntryEnvelope(owner.did, [owner.did], jws))) as Record<string, unknown>).status).toBe('delivered')

    const resp = await client.syncRequest(syncRequestEnvelope(owner.did, docId, {}))
    expect((resp.body as { entries: string[] }).entries).toHaveLength(1)

    await client.disconnect()
  })

  it('gate: with NO presented capability, log-entry AND sync-request are both rejected with CAPABILITY_REQUIRED', async () => {
    const docId = randomUUID()
    const alice = await makeRawIdentity('no-scope')
    const client = new TestClient(alice)
    await client.connect()

    // No present-capability at all.
    const jws = await buildLogEntryJws({ identity: alice, docId, seq: 0, plaintext: 'blocked' })
    expect(await client.send(logEntryEnvelope(alice.did, [alice.did], jws))).toMatchObject({ error: 'CAPABILITY_REQUIRED' })
    expect(await client.send(syncRequestEnvelope(alice.did, docId, {}))).toMatchObject({ error: 'CAPABILITY_REQUIRED' })

    // Nothing was stored (the gate ran before any durable side effect).
    const cap = await mintPersonalDocCapability({ owner: alice, docId, permissions: ['read'] })
    await client.presentCapability(cap)
    const resp = await client.syncRequest(syncRequestEnvelope(alice.did, docId, {}))
    expect((resp.body as { entries: string[] }).entries).toEqual([])

    await client.disconnect()
  })

  it('gate: a READ-only scope still rejects log-entry with CAPABILITY_REQUIRED (write requires a write scope)', async () => {
    const docId = randomUUID()
    const alice = await makeRawIdentity('read-only')
    const keypair = await makeSpaceCapabilityKeypair()
    const client = new TestClient(alice)
    await client.connect()

    await client.sendSpaceRegister({
      signer: alice,
      spaceId: docId,
      spaceCapabilityVerificationKey: keypair.verificationKey,
      adminDids: [alice.did],
    })
    // READ-only capability.
    const cap = await mintSpaceCapability({ keypair, spaceId: docId, audience: alice.did, permissions: ['read'] })
    expect(((await client.presentCapability(cap)) as Record<string, unknown>).status).toBe('delivered')

    // sync-request (read) works…
    expect((await client.syncRequest(syncRequestEnvelope(alice.did, docId, {}))).type).toBe(protocol.SYNC_RESPONSE_MESSAGE_TYPE)
    // …but log-entry (write) is rejected.
    const jws = await buildLogEntryJws({ identity: alice, docId, seq: 0, plaintext: 'no-write' })
    expect(await client.send(logEntryEnvelope(alice.did, [alice.did], jws))).toMatchObject({ error: 'CAPABILITY_REQUIRED' })

    await client.disconnect()
  })

  it('present-capability: a space capability for the WRONG audience is rejected with CAPABILITY_INVALID', async () => {
    const docId = randomUUID()
    const alice = await makeRawIdentity('wrong-aud-self')
    const other = await makeRawIdentity('wrong-aud-other')
    const keypair = await makeSpaceCapabilityKeypair()
    const client = new TestClient(alice)
    await client.connect()

    await client.sendSpaceRegister({
      signer: alice,
      spaceId: docId,
      spaceCapabilityVerificationKey: keypair.verificationKey,
      adminDids: [alice.did],
    })
    // Capability minted for `other`, presented by alice → audience mismatch.
    const cap = await mintSpaceCapability({ keypair, spaceId: docId, audience: other.did, permissions: ['read', 'write'] })
    expect(await client.presentCapability(cap)).toMatchObject({ error: 'CAPABILITY_INVALID' })

    // No scope cached → write still blocked.
    const jws = await buildLogEntryJws({ identity: alice, docId, seq: 0, plaintext: 'x' })
    expect(await client.send(logEntryEnvelope(alice.did, [alice.did], jws))).toMatchObject({ error: 'CAPABILITY_REQUIRED' })

    await client.disconnect()
  })

  it('present-capability: a malformed frame (extra top-level field) is rejected with MALFORMED_MESSAGE', async () => {
    const docId = randomUUID()
    const owner = await makeRawIdentity('malformed-present')
    const client = new TestClient(owner)
    await client.connect()

    const cap = await mintPersonalDocCapability({ owner, docId, permissions: ['read', 'write'] })
    // The frame MUST carry exactly { type, capabilityJws } (closed control-frame).
    expect(await client.sendControlFrame({ type: 'present-capability', capabilityJws: cap, thid: randomUUID() })).toMatchObject({
      error: 'MALFORMED_MESSAGE',
    })

    // The malformed frame cached nothing → write still blocked.
    const jws = await buildLogEntryJws({ identity: owner, docId, seq: 0, plaintext: 'x' })
    expect(await client.send(logEntryEnvelope(owner.did, [owner.did], jws))).toMatchObject({ error: 'CAPABILITY_REQUIRED' })

    await client.disconnect()
  })

  it('present-capability before challenge-response auth is rejected with NOT_REGISTERED', async () => {
    const docId = randomUUID()
    const owner = await makeRawIdentity('unauth-present')

    // Open a raw socket but DO NOT complete the handshake; send present-capability
    // immediately. The relay requires an authenticated socket (audience binding).
    const outcome = await new Promise<{ code: string }>((resolve, reject) => {
      const ws = new WebSocket(RELAY_URL)
      const timer = setTimeout(() => {
        ws.close()
        reject(new Error('Timeout waiting for present-capability error'))
      }, 2000)
      ws.on('open', async () => {
        const cap = await mintPersonalDocCapability({ owner, docId, permissions: ['read', 'write'] })
        ws.send(JSON.stringify({ type: 'present-capability', capabilityJws: cap }))
      })
      ws.on('message', (data) => {
        const msg = JSON.parse(data.toString()) as RelayMessage
        if (msg.type === 'error') {
          clearTimeout(timer)
          ws.close()
          resolve({ code: msg.code })
        }
      })
      ws.on('error', reject)
    })
    expect(outcome.code).toBe('NOT_REGISTERED')
  })

  it('CAPABILITY_GENERATION_STALE: a capability whose generation is behind the live space generation is rejected', async () => {
    // The generation-aware gate driven by a REAL space-rotate (Phase 5, VE-6). The
    // admin rotates the space to gen 1 with a new verification key; a gen-0 capability
    // (minted against the OLD key) is then STALE, and a gen-1 capability (minted
    // against the NEW key) verifies and enables writes. (The dedicated cross-socket
    // member-removal invalidation path lives in SpaceRotate.test.ts.)
    const docId = randomUUID()
    const alice = await makeRawIdentity('stale-gen')
    const gen0 = await makeSpaceCapabilityKeypair()
    const client = new TestClient(alice)
    await client.connect()

    await client.sendSpaceRegister({
      signer: alice,
      spaceId: docId,
      spaceCapabilityVerificationKey: gen0.verificationKey,
      adminDids: [alice.did],
    })

    // Real space-rotate to gen 1 with a fresh verification key (alice is the admin).
    const gen1 = await makeSpaceCapabilityKeypair()
    expect(
      (
        (await client.sendSpaceRotate({
          signer: alice,
          spaceId: docId,
          newSpaceCapabilityVerificationKey: gen1.verificationKey,
          newGeneration: 1,
        })) as Record<string, unknown>
      ).status,
    ).toBe('delivered')
    expect(docLogOf(server).getSpace(docId)?.generation).toBe(1)

    // A gen-0 capability (old key) is now STALE relative to the live gen 1.
    const staleCap = await mintSpaceCapability({ keypair: gen0, spaceId: docId, audience: alice.did, permissions: ['read', 'write'], generation: 0 })
    expect(await client.presentCapability(staleCap)).toMatchObject({ error: 'CAPABILITY_GENERATION_STALE' })

    // A gen-1 capability (new key) verifies and enables writes (the gate is
    // generation-aware, not a blanket reject).
    const freshCap = await mintSpaceCapability({ keypair: gen1, spaceId: docId, audience: alice.did, permissions: ['read', 'write'], generation: 1 })
    expect(((await client.presentCapability(freshCap)) as Record<string, unknown>).status).toBe('delivered')
    // The write MUST carry keyGeneration 1 now that the space is at gen 1 — a gen-0
    // entry would be rejected by the VE-R1 ingest-generations-gate (KEY_GENERATION_STALE).
    const jws = await buildLogEntryJws({ identity: alice, docId, seq: 0, plaintext: 'gen1-ok', keyGeneration: 1 })
    expect(((await client.send(logEntryEnvelope(alice.did, [alice.did], jws))) as Record<string, unknown>).status).toBe('delivered')

    await client.disconnect()
  })

  it('VE-8: the initial space-register for a docId drops a previously-cached PERSONAL scope on the open socket', async () => {
    // Before any space-register a docId is a Personal-Doc; a socket can cache a
    // self-issued personal WRITE scope. The first space-register for that docId
    // (Sync 003 §Scope-Invalidierung bei Erst-Register, MUSS) MUST drop that cached
    // personal scope across ALL open sockets, so the now-mandatory Space path cannot
    // be bypassed on the still-open connection.
    const docId = randomUUID()
    const alice = await makeRawIdentity('ve8-alice')
    const admin = await makeRawIdentity('ve8-admin')
    const keypair = await makeSpaceCapabilityKeypair()

    const aliceClient = new TestClient(alice)
    // A SECOND socket of the SAME owner DID, used to drive the upgrade — so the scope drop on
    // aliceClient's socket below is genuinely cross-socket (the VE-8 property), while the register
    // is OWNER-SIGNED (the A2 Teil B anti-escalation requirement).
    const aliceClient2 = new TestClient(alice)
    await aliceClient.connect()
    await aliceClient2.connect()

    // (1) docId not yet registered → PERSONAL path. Alice caches a personal WRITE
    // scope on socket 1 and a write succeeds.
    const personalCap = await mintPersonalDocCapability({ owner: alice, docId, permissions: ['read', 'write'] })
    expect(((await aliceClient.presentCapability(personalCap)) as Record<string, unknown>).status).toBe('delivered')
    const jws0 = await buildLogEntryJws({ identity: alice, docId, seq: 0, plaintext: 've8-before' })
    expect(((await aliceClient.send(logEntryEnvelope(alice.did, [alice.did], jws0))) as Record<string, unknown>).status).toBe('delivered')

    // (2) The INITIAL space-register for the SAME docId, OWNER-SIGNED. A2 Teil B anti-escalation:
    // presenting a personal capability (step 1) CLAIMS personal ownership (TOFU), so promoting that
    // docId to a space requires the owner's CRYPTOGRAPHIC consent — the space-register MUST be
    // SIGNED BY the owner (signerDid == alice), NOT merely list alice among adminDids. A foreign
    // signer is rejected PERSONAL_DOC_OWNER_MISMATCH even with the owner as a decoy co-admin (see
    // DocLog.test.ts). Sent from alice's SECOND socket; the owner-consented upgrade clears the
    // personal binding and drops the scope cached on socket 1.
    expect(
      (
        (await aliceClient2.sendSpaceRegister({
          signer: alice,
          spaceId: docId,
          spaceCapabilityVerificationKey: keypair.verificationKey,
          adminDids: [alice.did, admin.did],
        })) as Record<string, unknown>
      ).status,
    ).toBe('delivered')
    expect(docLogOf(server).isSpaceRegistered(docId)).toBe(true)

    // (3) Alice's previously-cached personal scope on socket 1 was dropped (cross-socket) → her
    // next write on the SAME open socket is rejected with CAPABILITY_REQUIRED.
    const jws1 = await buildLogEntryJws({ identity: alice, docId, seq: 1, plaintext: 've8-after' })
    expect(await aliceClient.send(logEntryEnvelope(alice.did, [alice.did], jws1))).toMatchObject({ error: 'CAPABILITY_REQUIRED' })

    // (4) Once Alice presents a SPACE capability (minted by the space keypair she registered) she
    // can write again — the Space path now governs the docId.
    const spaceCap = await mintSpaceCapability({ keypair, spaceId: docId, audience: alice.did, permissions: ['read', 'write'] })
    expect(((await aliceClient.presentCapability(spaceCap)) as Record<string, unknown>).status).toBe('delivered')
    expect(((await aliceClient.send(logEntryEnvelope(alice.did, [alice.did], jws1))) as Record<string, unknown>).status).toBe('delivered')

    await aliceClient.disconnect()
    await aliceClient2.disconnect()
  })

  it('inbox cold-start is UNGATED: a space-invite flows + is ackable without any presented capability', async () => {
    // The Inbox channel (space-invite/ack) MUST NOT be capability-gated — otherwise a
    // fresh client could never receive its FIRST capability (Cold-Start, Sync 003
    // §Gate). Neither the sender nor the recipient presents any capability here.
    const sender = await makeRawIdentity('inbox-sender')
    const recipient = await makeRawIdentity('inbox-recipient')

    const senderClient = new TestClient(sender)
    await senderClient.connect()

    // Recipient is OFFLINE → a space-invite DIDComm envelope is queued ('accepted'),
    // NOT rejected with CAPABILITY_REQUIRED.
    const inviteId = randomUUID()
    const invite: Record<string, unknown> = {
      typ: DIDCOMM_PLAINTEXT_TYP,
      type: SPACE_INVITE_MESSAGE_TYPE,
      id: inviteId,
      from: sender.did,
      to: [recipient.did],
      created_time: Math.floor(Date.now() / 1000),
      body: { epk: 'e', nonce: 'n', ciphertext: 'c' },
    }
    const sendOutcome = await senderClient.send(invite)
    expect((sendOutcome as Record<string, unknown>).status).toBe('accepted')

    // Recipient connects (NO capability) and receives the queued invite.
    const recipientClient = new TestClient(recipient)
    await recipientClient.connect()
    const delivered = await recipientClient.nextMessage()
    expect(delivered.type).toBe(SPACE_INVITE_MESSAGE_TYPE)
    expect(delivered.id).toBe(inviteId)

    // Recipient acks via ack/1.0 (also ungated) → delivered.
    const ack = protocol.createAckMessage({
      id: randomUUID(),
      from: recipient.did,
      to: [sender.did],
      createdTime: Math.floor(Date.now() / 1000),
      thid: inviteId,
      body: { messageId: inviteId },
    }) as unknown as Record<string, unknown>
    expect(((await recipientClient.send(ack)) as Record<string, unknown>).status).toBe('delivered')

    await senderClient.disconnect()
    await recipientClient.disconnect()
  })

  it('BLOCKER 2 (SPACE + PERSONAL) — a presented capability stops authorizing once now >= validUntil; log-entry AND sync-request are rejected CAPABILITY_EXPIRED and nothing is stored/served', async () => {
    // Sync 003 §Capability-Prüfung: `validUntil` bounds access. A cached scope MUST
    // NOT keep authorizing after it expires (until WS close). We present a short-lived
    // capability while the injected clock is BEFORE validUntil (so present succeeds),
    // then advance the clock PAST validUntil; the cached-but-expired scope is dropped +
    // rejected CAPABILITY_EXPIRED on the WRITE gate (log-entry) AND, with a freshly
    // re-presented scope, on the READ gate (sync-request). Covered for BOTH the Space
    // and Personal paths. (The gate DELETES an expired scope on first detection, so
    // each gate assertion uses its own freshly-presented-then-expired scope — that is
    // the spec behavior: the first hit reports EXPIRED, then the client must re-present.)
    const validUntil = '2026-06-23T12:00:00Z'
    const expiryMs = Date.parse(validUntil)
    const beforeExpiry = expiryMs - 60_000
    const afterExpiry = expiryMs + 1_000
    let clock = beforeExpiry

    // Replace the beforeEach server with a clock-injected one on the SAME port (the
    // module afterEach stops whatever `server` points at). The TestClient targets
    // RELAY_URL (= this port), so no wiring change is needed.
    await server.stop()
    server = new RelayServer({ port: PORT, now: () => clock })
    await server.start()

    // ============================ SPACE path ============================
    const spaceDoc = randomUUID()
    const admin = await makeRawIdentity('b2-space-admin')
    const keypair = await makeSpaceCapabilityKeypair()
    const spaceClient = new TestClient(admin)
    await spaceClient.connect()
    expect(
      ((await spaceClient.sendSpaceRegister({
        signer: admin,
        spaceId: spaceDoc,
        spaceCapabilityVerificationKey: keypair.verificationKey,
        adminDids: [admin.did],
      })) as Record<string, unknown>).status,
    ).toBe('delivered')
    const mintSpaceRw = () => mintSpaceCapability({ keypair, spaceId: spaceDoc, audience: admin.did, permissions: ['read', 'write'], validUntil })

    // Present (clock < validUntil) and write ONE baseline entry while valid.
    expect(((await spaceClient.presentCapability(await mintSpaceRw())) as Record<string, unknown>).status).toBe('delivered')
    const baseJws = await buildLogEntryJws({ identity: admin, docId: spaceDoc, seq: 0, plaintext: 'space-before-expiry' })
    expect(((await spaceClient.send(logEntryEnvelope(admin.did, [admin.did], baseJws))) as Record<string, unknown>).status).toBe('delivered')

    // WRITE gate: advance past validUntil → the cached scope is expired → log-entry
    // rejected CAPABILITY_EXPIRED (and the post-expiry entry is NOT stored, asserted later).
    clock = afterExpiry
    const spaceAfterJws = await buildLogEntryJws({ identity: admin, docId: spaceDoc, seq: 1, plaintext: 'space-after-expiry' })
    expect(await spaceClient.send(logEntryEnvelope(admin.did, [admin.did], spaceAfterJws))).toMatchObject({ error: 'CAPABILITY_EXPIRED' })

    // READ gate: rewind, re-present a fresh scope, advance past validUntil again →
    // sync-request rejected CAPABILITY_EXPIRED (nothing served).
    clock = beforeExpiry
    expect(((await spaceClient.presentCapability(await mintSpaceRw())) as Record<string, unknown>).status).toBe('delivered')
    clock = afterExpiry
    expect(await spaceClient.send(syncRequestEnvelope(admin.did, spaceDoc, {}))).toMatchObject({ error: 'CAPABILITY_EXPIRED' })

    // =========================== PERSONAL path ===========================
    const personalDoc = randomUUID() // no space-register → personal path
    const owner = await makeRawIdentity('b2-personal-owner')
    const personalClient = new TestClient(owner)
    await personalClient.connect()
    const mintPersonalRw = () => mintPersonalDocCapability({ owner, docId: personalDoc, permissions: ['read', 'write'], validUntil })

    // WRITE gate.
    clock = beforeExpiry
    expect(((await personalClient.presentCapability(await mintPersonalRw())) as Record<string, unknown>).status).toBe('delivered')
    clock = afterExpiry
    const personalAfter = await buildLogEntryJws({ identity: owner, docId: personalDoc, seq: 0, plaintext: 'personal-after-expiry' })
    expect(await personalClient.send(logEntryEnvelope(owner.did, [owner.did], personalAfter))).toMatchObject({ error: 'CAPABILITY_EXPIRED' })

    // READ gate.
    clock = beforeExpiry
    expect(((await personalClient.presentCapability(await mintPersonalRw())) as Record<string, unknown>).status).toBe('delivered')
    clock = afterExpiry
    expect(await personalClient.send(syncRequestEnvelope(owner.did, personalDoc, {}))).toMatchObject({ error: 'CAPABILITY_EXPIRED' })

    // ===================== nothing stored after expiry =====================
    // Rewind so a freshly-presented cap is valid, re-present, and read: the Space doc
    // holds ONLY the single pre-expiry baseline entry (the post-expiry write never
    // reached the log), and the never-written Personal doc holds ZERO entries.
    clock = beforeExpiry
    expect(((await spaceClient.presentCapability(await mintSpaceRw())) as Record<string, unknown>).status).toBe('delivered')
    const spaceResp = await spaceClient.syncRequest(syncRequestEnvelope(admin.did, spaceDoc, {}))
    expect((spaceResp.body as { entries: string[] }).entries).toHaveLength(1)

    expect(((await personalClient.presentCapability(await mintPersonalRw())) as Record<string, unknown>).status).toBe('delivered')
    const personalResp = await personalClient.syncRequest(syncRequestEnvelope(owner.did, personalDoc, {}))
    expect((personalResp.body as { entries: string[] }).entries).toHaveLength(0)

    await spaceClient.disconnect()
    await personalClient.disconnect()
  })

  it('BLOCKER 3 — re-registering an authenticated WS as a different DID is rejected; Alice keeps her scope (write still works) + live routing on that socket', async () => {
    // One WS = one session (Sync 003 §Authentisierung). A socket authenticated as
    // Alice that presents an Alice write scope MUST NOT be re-bound to Bob: rebinding
    // would leak Alice's cached scope and keep routing Alice's live messages to the
    // socket. We reject the re-registration outright (AUTH_INVALID). Then we prove on
    // the SAME socket that (a) the rebind was rejected, (b) Alice's cached write scope
    // still authorizes a log-entry, and (c) a live message addressed to Alice still
    // arrives on that socket (routing target intact, NOT moved to Bob).
    const docId = randomUUID()
    const alice = await makeRawIdentity('b3-alice')
    const bob = await makeRawIdentity('b3-bob')
    const aliceSibling = await makeRawIdentity('b3-alice-sibling') // a second device of Alice's DID

    // A tiny request/response driver over ONE raw Alice socket. Resolves outcomes
    // (receipt|error) in order and buffers inbound `message` envelopes.
    const ws = new WebSocket(RELAY_URL)
    const outcomeWaiters: Array<(o: Record<string, unknown> | { error: string }) => void> = []
    const messageBuffer: Record<string, unknown>[] = []
    const messageWaiters: Array<(env: Record<string, unknown>) => void> = []
    const nextOutcome = () =>
      new Promise<Record<string, unknown> | { error: string }>((resolve, reject) => {
        const t = setTimeout(() => reject(new Error('Timeout waiting for outcome')), 2000)
        outcomeWaiters.push((o) => {
          clearTimeout(t)
          resolve(o)
        })
      })
    const nextMessage = () =>
      new Promise<Record<string, unknown>>((resolve, reject) => {
        const buffered = messageBuffer.shift()
        if (buffered) return resolve(buffered)
        const t = setTimeout(() => reject(new Error('Timeout waiting for message')), 2000)
        messageWaiters.push((env) => {
          clearTimeout(t)
          resolve(env)
        })
      })

    const aliceAuthed = new Promise<void>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('Timeout authenticating Alice')), 2000)
      ws.on('open', () => ws.send(JSON.stringify({ type: 'register', did: alice.did, deviceId: alice.deviceId })))
      ws.on('message', (data) => {
        const msg = JSON.parse(data.toString()) as RelayMessage
        if (msg.type === 'challenge') {
          const transcript = buildBrokerAuthTranscript({ did: alice.did, deviceId: alice.deviceId, nonce: msg.nonce })
          const signingBytes = createBrokerAuthTranscriptSigningBytes(transcript)
          alice
            .signTranscriptBytes(signingBytes)
            .then((sig) =>
              ws.send(JSON.stringify({
                type: 'challenge-response',
                did: alice.did,
                deviceId: alice.deviceId,
                nonce: msg.nonce,
                signature: formatBrokerChallengeResponseSignature(sig),
              })),
            )
            .catch(reject)
        } else if (msg.type === 'registered') {
          clearTimeout(t)
          resolve()
        } else if (msg.type === 'receipt') {
          outcomeWaiters.shift()?.(msg.receipt as unknown as Record<string, unknown>)
        } else if (msg.type === 'error') {
          outcomeWaiters.shift()?.({ error: msg.code })
        } else if (msg.type === 'message') {
          const w = messageWaiters.shift()
          if (w) w(msg.envelope)
          else messageBuffer.push(msg.envelope)
        }
      })
      ws.on('error', reject)
    })
    await aliceAuthed

    // Alice presents a personal write scope (cached for this socket).
    const cap = await mintPersonalDocCapability({ owner: alice, docId, permissions: ['read', 'write'] })
    ws.send(JSON.stringify({ type: 'present-capability', capabilityJws: cap }))
    expect((await nextOutcome() as Record<string, unknown>).status).toBe('delivered')

    // Attempt to re-register the SAME socket as Bob → rejected outright (AUTH_INVALID).
    ws.send(JSON.stringify({ type: 'register', did: bob.did, deviceId: bob.deviceId }))
    expect(await nextOutcome()).toMatchObject({ error: 'AUTH_INVALID' })

    // The relay never bound the socket to Bob: Alice is connected, Bob is not.
    expect(server.connectedDids).toContain(alice.did)
    expect(server.connectedDids).not.toContain(bob.did)

    // (b) Alice's cached write scope STILL authorizes a log-entry on this socket (the
    // rejected rebind did not clear socketToScopes).
    const jws = await buildLogEntryJws({ identity: alice, docId, seq: 0, plaintext: 'alice-still-writes' })
    ws.send(JSON.stringify({ type: 'send', envelope: logEntryEnvelope(alice.did, [bob.did], jws) }))
    expect((await nextOutcome() as Record<string, unknown>).status).toBe('delivered')

    // (c) A live message addressed to ALICE still arrives on this socket: a sibling
    // device of Alice's DID sends Alice an inbox message; the relay fans it out to
    // Alice's connected sockets (this one) — proving routing stayed with Alice, not Bob.
    const siblingClient = new TestClient(aliceSibling)
    await siblingClient.connect()
    const liveId = randomUUID()
    const inbox: Record<string, unknown> = {
      typ: DIDCOMM_PLAINTEXT_TYP,
      type: SPACE_INVITE_MESSAGE_TYPE,
      id: liveId,
      from: aliceSibling.did,
      to: [alice.did],
      created_time: Math.floor(Date.now() / 1000),
      body: { epk: 'e', nonce: 'n', ciphertext: 'c' },
    }
    await siblingClient.send(inbox)
    const delivered = await nextMessage()
    expect(delivered.id).toBe(liveId)

    await siblingClient.disconnect()
    await new Promise<void>((resolve) => {
      ws.on('close', () => resolve())
      ws.close()
    })
  })
})
