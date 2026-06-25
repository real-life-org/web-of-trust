import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { randomUUID, randomBytes } from 'crypto'
import WebSocket from 'ws'
import { RelayServer } from '../src/relay.js'
import type { RelayMessage } from '../src/types.js'
import { protocol, WebCryptoProtocolCryptoAdapter } from '@web_of_trust/core'

// Slice SR Phase 1 — RELAY: VE-R1 Broker-Ingest-Generations-Gate + VE-R2
// Relay-Whitelist (wot-spec #110, 003-transport-und-broker.md).
//
// VE-R1 (Broker-Ingest-Generations-Gate, MUSS, sicherheitskritisch): for a
// REGISTERED space-docId the broker MUST reject — after JWS verification and
// author-binding, before store/relay — a log-entry whose keyGeneration is STRICTLY
// LESS than the durable space.generation → KEY_GENERATION_STALE; the entry is
// NEITHER stored NOR relayed. keyGeneration >= generation MUST be accepted,
// including a future generation the broker has not seen yet (NOT buffered). The
// comparison reads the DURABLE generation (getSpace), not the capability cache, so
// it is race-safe against a concurrent rotation. For generation 0, 0 < 0 is false
// → accepted. A Personal-Doc (no space-register) makes the gate a no-op.
//
// VE-R2 (Relay-Whitelist, MUSS): the broker relays/queues EXCLUSIVELY messages of
// DEFINED transport types (those in the Nachrichtentypen-Tabelle) plus the defined
// control-frames. Every other message — an unknown type, a client-originated
// sync-response/1.0 (only the broker emits sync-response), or the deprecated
// old-world content envelope (v:1/fromDid/toDid) — MUST be rejected with
// MALFORMED_MESSAGE and NEITHER relayed NOR queued. This closes the un-gated
// channel the log-entry generations-gate does not cover.

const PORT = 9893
const RELAY_URL = `ws://localhost:${PORT}`
const FIXED_TIMESTAMP = '2026-06-24T10:00:00Z'
const CAP_ISSUED_AT = '2026-01-01T00:00:00Z'
const CAP_VALID_UNTIL = '2099-01-01T00:00:00Z'

const cryptoAdapter = new WebCryptoProtocolCryptoAdapter()
const {
  buildBrokerAuthTranscript,
  createBrokerAuthTranscriptSigningBytes,
  formatBrokerChallengeResponseSignature,
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
  const seed = await cryptoAdapter.sha256(new TextEncoder().encode(`secure-removal-relay-test/seed/${label}`))
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

// --- Space Capability keypair -------------------------------------------------

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

// --- log-entry envelope builder ----------------------------------------------

async function buildLogEntryJws(params: {
  identity: RawIdentity
  docId: string
  seq: number
  plaintext: string
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

// --- minimal authenticated relay client over ws ------------------------------

type SendOutcome = Record<string, unknown> | { error: string; clientHint?: string }

class TestClient {
  private ws: WebSocket | null = null
  /** Every relayed/delivered `message` envelope this socket received. */
  readonly messages: Record<string, unknown>[] = []
  /** The raw frames of every `error` this socket received (VE-C2: assert `thid`). */
  readonly errorFrames: Record<string, unknown>[] = []
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
          case 'message': {
            this.messages.push(msg.envelope)
            break
          }
          case 'receipt': {
            const waiter = this.outcomeWaiters.shift()
            if (waiter) waiter(msg.receipt as unknown as Record<string, unknown>)
            break
          }
          case 'error': {
            this.errorFrames.push(msg as unknown as Record<string, unknown>)
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

  presentCapability(capabilityJws: string): Promise<SendOutcome> {
    return this.sendControlFrame({ type: 'present-capability', capabilityJws })
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

  disconnect(): Promise<void> {
    return new Promise((resolve) => {
      if (!this.ws) return resolve()
      this.ws.on('close', () => resolve())
      this.ws.close()
      this.ws = null
    })
  }
}

/** Inspect the server's durable state (test-only). */
function inspect(server: RelayServer): {
  getSpace: (id: string) => { verificationKey: string; generation: number } | null
  entryCount: (docId?: string) => number
  queueCount: (did?: string) => number
  rotateSpace: (id: string, key: string, gen: number) => void
} {
  const internal = server as unknown as {
    docLog: {
      getSpace: (id: string) => { verificationKey: string; generation: number } | null
      entryCount: (docId?: string) => number
      rotateSpace: (id: string, key: string, gen: number) => void
    }
    queue: { count: (did?: string) => number }
  }
  return {
    getSpace: (id) => internal.docLog.getSpace(id),
    entryCount: (docId) => internal.docLog.entryCount(docId),
    queueCount: (did) => internal.queue.count(did),
    rotateSpace: (id, key, gen) => internal.docLog.rotateSpace(id, key, gen),
  }
}

const status = (o: SendOutcome) => (o as Record<string, unknown>).status

/** Register a space at gen 0 and present a read+write capability for `member`. */
async function registerSpaceWithMember(params: {
  server: RelayServer
  adminClient: TestClient
  admin: RawIdentity
  memberClient: TestClient
  member: RawIdentity
  docId: string
  keypair: SpaceCapabilityKeypair
}): Promise<void> {
  expect(
    status(
      await params.adminClient.sendSpaceRegister({
        signer: params.admin,
        spaceId: params.docId,
        spaceCapabilityVerificationKey: params.keypair.verificationKey,
        adminDids: [params.admin.did],
      }),
    ),
  ).toBe('delivered')
  const cap = await mintSpaceCapability({
    keypair: params.keypair,
    spaceId: params.docId,
    audience: params.member.did,
    permissions: ['read', 'write'],
    generation: 0,
  })
  expect(status(await params.memberClient.presentCapability(cap))).toBe('delivered')
}

describe('Slice SR Phase 1 — RELAY VE-R1 generations-gate + VE-R2 whitelist', () => {
  let server: RelayServer

  beforeEach(async () => {
    server = new RelayServer({ port: PORT })
    await server.start()
  })

  afterEach(async () => {
    await server.stop()
  })

  // --- VE-R1 generations-gate ------------------------------------------------

  it('GATE <: a log-entry at keyGeneration 0 after a rotate to gen 1 is rejected KEY_GENERATION_STALE; not stored, not relayed', async () => {
    // The core security invariant: a just-removed member who still holds the old
    // content key writes under keyGeneration 0 while the space is at gen 1. The gate
    // rejects it KEY_GENERATION_STALE — the entry never enters the durable log and is
    // never relayed to the remaining member.
    const docId = randomUUID()
    const admin = await makeRawIdentity('gate-lt-admin')
    const member = await makeRawIdentity('gate-lt-member')
    const peer = await makeRawIdentity('gate-lt-peer')
    const gen0 = await makeSpaceCapabilityKeypair()

    const adminClient = new TestClient(admin)
    const memberClient = new TestClient(member)
    const peerClient = new TestClient(peer)
    await adminClient.connect()
    await memberClient.connect()
    await peerClient.connect()

    await registerSpaceWithMember({ server, adminClient, admin, memberClient, member, docId, keypair: gen0 })

    // Admin rotates to gen 1 with a fresh key (the member-removal mechanism). The
    // member keeps a still-open socket but its gen-0 scope is invalidated, so we
    // re-present a freshly minted gen-1 capability to ISOLATE the generations-gate
    // (without a cached write scope the capability gate would reject first).
    const gen1 = await makeSpaceCapabilityKeypair()
    expect(
      status(
        await adminClient.sendSpaceRotate({
          signer: admin,
          spaceId: docId,
          newSpaceCapabilityVerificationKey: gen1.verificationKey,
          newGeneration: 1,
        }),
      ),
    ).toBe('delivered')
    expect(inspect(server).getSpace(docId)?.generation).toBe(1)
    const memberCap1 = await mintSpaceCapability({
      keypair: gen1,
      spaceId: docId,
      audience: member.did,
      permissions: ['read', 'write'],
      generation: 1,
    })
    expect(status(await memberClient.presentCapability(memberCap1))).toBe('delivered')

    // The member writes a STALE keyGeneration-0 entry (old content key). The gate
    // rejects it AFTER the capability gate + author-binding pass.
    const staleJws = await buildLogEntryJws({ identity: member, docId, seq: 5, plaintext: 'stale', keyGeneration: 0 })
    const staleEnvelope = logEntryEnvelope(member.did, [peer.did], staleJws)
    expect(await memberClient.send(staleEnvelope)).toMatchObject({
      error: 'KEY_GENERATION_STALE',
    })

    // VE-C2 (the load-bearing relay change): the KEY_GENERATION_STALE error frame
    // MUST carry `thid == the rejected envelope id`, so the legitimate lagger's
    // LogSyncCoordinator can correlate it back to the in-flight write and run the
    // catch-up-and-re-emit. Without thid the client drops the error (greenwash trap).
    const staleError = memberClient.errorFrames.find((f) => f.code === 'KEY_GENERATION_STALE')
    expect(staleError).toBeDefined()
    expect(staleError!.thid).toBe(staleEnvelope.id)

    // Neither stored nor relayed: the durable log has no entry for this doc and the
    // peer (a recipient in `to`) received no message.
    expect(inspect(server).entryCount(docId)).toBe(0)
    expect(peerClient.messages).toHaveLength(0)

    await adminClient.disconnect()
    await memberClient.disconnect()
    await peerClient.disconnect()
  })

  it('GATE >=: a log-entry at keyGeneration == space.generation is accepted (stored)', async () => {
    const docId = randomUUID()
    const admin = await makeRawIdentity('gate-eq-admin')
    const member = await makeRawIdentity('gate-eq-member')
    const gen0 = await makeSpaceCapabilityKeypair()

    const adminClient = new TestClient(admin)
    const memberClient = new TestClient(member)
    await adminClient.connect()
    await memberClient.connect()

    await registerSpaceWithMember({ server, adminClient, admin, memberClient, member, docId, keypair: gen0 })

    // Space is at gen 0; a keyGeneration-0 entry (0 < 0 is false) is accepted.
    const jws = await buildLogEntryJws({ identity: member, docId, seq: 0, plaintext: 'eq', keyGeneration: 0 })
    expect(status(await memberClient.send(logEntryEnvelope(member.did, [admin.did], jws)))).toBe('delivered')
    expect(inspect(server).entryCount(docId)).toBe(1)

    await adminClient.disconnect()
    await memberClient.disconnect()
  })

  it('GATE >=: a log-entry at a FUTURE keyGeneration the broker has not rotated to yet is accepted (multi-broker liveness; not buffered, persisted)', async () => {
    // The broker is still at gen 0 but a member writes under keyGeneration 1 (it saw
    // a rotation this broker has not processed). The gate accepts (1 < 0 is false) and
    // the entry is PERSISTED immediately — NOT buffered until the broker rotates.
    const docId = randomUUID()
    const admin = await makeRawIdentity('gate-future-admin')
    const member = await makeRawIdentity('gate-future-member')
    const gen0 = await makeSpaceCapabilityKeypair()

    const adminClient = new TestClient(admin)
    const memberClient = new TestClient(member)
    await adminClient.connect()
    await memberClient.connect()

    await registerSpaceWithMember({ server, adminClient, admin, memberClient, member, docId, keypair: gen0 })
    expect(inspect(server).getSpace(docId)?.generation).toBe(0) // broker NOT rotated

    const futureJws = await buildLogEntryJws({ identity: member, docId, seq: 0, plaintext: 'future', keyGeneration: 1 })
    expect(status(await memberClient.send(logEntryEnvelope(member.did, [admin.did], futureJws)))).toBe('delivered')
    // Persisted, not buffered.
    expect(inspect(server).entryCount(docId)).toBe(1)
    expect(inspect(server).getSpace(docId)?.generation).toBe(0)

    await adminClient.disconnect()
    await memberClient.disconnect()
  })

  it('GATE gen-0: a never-rotated space accepts a keyGeneration-0 entry (0 < 0 is false)', async () => {
    const docId = randomUUID()
    const admin = await makeRawIdentity('gate-gen0-admin')
    const member = await makeRawIdentity('gate-gen0-member')
    const gen0 = await makeSpaceCapabilityKeypair()

    const adminClient = new TestClient(admin)
    const memberClient = new TestClient(member)
    await adminClient.connect()
    await memberClient.connect()

    await registerSpaceWithMember({ server, adminClient, admin, memberClient, member, docId, keypair: gen0 })
    expect(inspect(server).getSpace(docId)?.generation).toBe(0)

    const jws = await buildLogEntryJws({ identity: member, docId, seq: 0, plaintext: 'gen0', keyGeneration: 0 })
    expect(status(await memberClient.send(logEntryEnvelope(member.did, [admin.did], jws)))).toBe('delivered')
    expect(inspect(server).entryCount(docId)).toBe(1)

    await adminClient.disconnect()
    await memberClient.disconnect()
  })

  it('GATE reads DURABLE generation, not the scope cache: a direct durable rotate makes the gate reject a stale entry immediately', async () => {
    // Drive the durable generation directly (rotateSpace) WITHOUT touching the
    // capability-scope cache: the member keeps a valid cached gen-0 write scope, yet a
    // keyGeneration-0 entry is rejected KEY_GENERATION_STALE because the gate reads the
    // durable space.generation (now 1), proving it is NOT the scope cache that decides.
    const docId = randomUUID()
    const admin = await makeRawIdentity('gate-durable-admin')
    const member = await makeRawIdentity('gate-durable-member')
    const gen0 = await makeSpaceCapabilityKeypair()

    const adminClient = new TestClient(admin)
    const memberClient = new TestClient(member)
    await adminClient.connect()
    await memberClient.connect()

    await registerSpaceWithMember({ server, adminClient, admin, memberClient, member, docId, keypair: gen0 })

    // A gen-0 write works while the durable generation is 0 (scope is cached + valid).
    const ok = await buildLogEntryJws({ identity: member, docId, seq: 0, plaintext: 'pre', keyGeneration: 0 })
    expect(status(await memberClient.send(logEntryEnvelope(member.did, [admin.did], ok)))).toBe('delivered')

    // Bump ONLY the durable generation (no scope invalidation, no present-capability).
    const gen1 = await makeSpaceCapabilityKeypair()
    inspect(server).rotateSpace(docId, gen1.verificationKey, 1)
    expect(inspect(server).getSpace(docId)?.generation).toBe(1)

    // The member's cached gen-0 write scope is still present and unexpired, so the
    // capability gate passes — but the durable-read generations-gate now rejects the
    // stale keyGeneration-0 entry.
    const stale = await buildLogEntryJws({ identity: member, docId, seq: 1, plaintext: 'stale', keyGeneration: 0 })
    expect(await memberClient.send(logEntryEnvelope(member.did, [admin.did], stale))).toMatchObject({
      error: 'KEY_GENERATION_STALE',
    })
    // Only the first (pre-rotation) entry is stored.
    expect(inspect(server).entryCount(docId)).toBe(1)

    await adminClient.disconnect()
    await memberClient.disconnect()
  })

  // --- VE-R2 whitelist -------------------------------------------------------

  it('WHITELIST reject: a client-originated sync-response/1.0 is rejected MALFORMED_MESSAGE; nothing delivered or queued', async () => {
    // Only the broker emits sync-response. A client that sends one via `send` is
    // rejected by the whitelist — it never reaches generic routing, so the addressed
    // recipient receives nothing and nothing is queued.
    const sender = await makeRawIdentity('wl-syncresp-sender')
    const recipient = await makeRawIdentity('wl-syncresp-recipient')

    const senderClient = new TestClient(sender)
    const recipientClient = new TestClient(recipient)
    await senderClient.connect()
    await recipientClient.connect()

    const forged = protocol.createSyncResponseMessage({
      id: randomUUID(),
      from: sender.did,
      to: [recipient.did],
      createdTime: Math.floor(Date.now() / 1000),
      thid: randomUUID(),
      body: { docId: randomUUID(), entries: [], heads: {}, truncated: false },
    }) as unknown as Record<string, unknown>

    expect(await senderClient.send(forged)).toMatchObject({ error: 'MALFORMED_MESSAGE' })
    expect(recipientClient.messages).toHaveLength(0)
    expect(inspect(server).queueCount(recipient.did)).toBe(0)

    await senderClient.disconnect()
    await recipientClient.disconnect()
  })

  it('WHITELIST reject: the deprecated old-world content envelope (v:1/fromDid/toDid) is rejected MALFORMED_MESSAGE; not relayed/queued', async () => {
    // The deprecated pipe-content channel — exactly the un-gated path a removed member
    // could use to deliver old-key content. The whitelist rejects it on type.
    const sender = await makeRawIdentity('wl-oldworld-sender')
    const recipient = await makeRawIdentity('wl-oldworld-recipient')

    const senderClient = new TestClient(sender)
    const recipientClient = new TestClient(recipient)
    await senderClient.connect()
    await recipientClient.connect()

    const oldWorld = {
      v: 1,
      id: randomUUID(),
      type: 'content',
      fromDid: sender.did,
      toDid: recipient.did,
      createdAt: FIXED_TIMESTAMP,
      encoding: 'json',
      payload: '{}',
      signature: '',
    }
    expect(await senderClient.send(oldWorld)).toMatchObject({ error: 'MALFORMED_MESSAGE' })
    expect(recipientClient.messages).toHaveLength(0)
    expect(inspect(server).queueCount(recipient.did)).toBe(0)

    await senderClient.disconnect()
    await recipientClient.disconnect()
  })

  it('WHITELIST reject: an envelope with an unknown DIDComm type is rejected MALFORMED_MESSAGE; not relayed/queued', async () => {
    const sender = await makeRawIdentity('wl-unknown-sender')
    const recipient = await makeRawIdentity('wl-unknown-recipient')

    const senderClient = new TestClient(sender)
    const recipientClient = new TestClient(recipient)
    await senderClient.connect()
    await recipientClient.connect()

    const unknown = {
      id: randomUUID(),
      typ: 'application/didcomm-plain+json',
      type: 'https://web-of-trust.de/protocols/totally-made-up/9.9',
      from: sender.did,
      to: [recipient.did],
      created_time: Math.floor(Date.now() / 1000),
      body: { smuggled: 'old-key-ciphertext' },
    }
    expect(await senderClient.send(unknown)).toMatchObject({ error: 'MALFORMED_MESSAGE' })
    expect(recipientClient.messages).toHaveLength(0)
    expect(inspect(server).queueCount(recipient.did)).toBe(0)

    await senderClient.disconnect()
    await recipientClient.disconnect()
  })

  it('WHITELIST allow: the four inbox transport types are still queued/relayed (cold-start not broken)', async () => {
    // space-invite/1.0 etc. MUST keep flowing or a fresh client could never receive
    // its first capability. Send each inbox type to an offline recipient and assert it
    // is queued (accepted), then delivered on connect.
    const sender = await makeRawIdentity('wl-inbox-sender')
    const recipient = await makeRawIdentity('wl-inbox-recipient')
    const senderClient = new TestClient(sender)
    await senderClient.connect()

    const inboxTypes = [
      'https://web-of-trust.de/protocols/inbox/1.0',
      'https://web-of-trust.de/protocols/space-invite/1.0',
      'https://web-of-trust.de/protocols/member-update/1.0',
      'https://web-of-trust.de/protocols/key-rotation/1.0',
    ] as const

    for (const type of inboxTypes) {
      const envelope = {
        id: randomUUID(),
        typ: 'application/didcomm-plain+json',
        type,
        from: sender.did,
        to: [recipient.did],
        created_time: Math.floor(Date.now() / 1000),
        body: { epk: 'ZXBr', nonce: 'bm9uY2U', ciphertext: 'Y2lwaGVydGV4dA' },
      }
      expect(status(await senderClient.send(envelope))).toBe('accepted')
    }
    // All four are queued for the offline recipient.
    expect(inspect(server).queueCount(recipient.did)).toBe(inboxTypes.length)

    // They are delivered when the recipient connects (cold-start path intact).
    const recipientClient = new TestClient(recipient)
    await recipientClient.connect()
    await new Promise((r) => setTimeout(r, 50))
    expect(recipientClient.messages).toHaveLength(inboxTypes.length)
    expect(recipientClient.messages.map((m) => m.type).sort()).toEqual([...inboxTypes].sort())

    await senderClient.disconnect()
    await recipientClient.disconnect()
  })
})
