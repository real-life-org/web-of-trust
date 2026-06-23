import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { randomUUID, randomBytes } from 'crypto'
import WebSocket from 'ws'
import { RelayServer } from '../src/relay.js'
import type { RelayMessage } from '../src/types.js'
import { protocol, WebCryptoProtocolCryptoAdapter } from '@web_of_trust/core'

// Slice CG / Phase 6 (VE-10) — acceptance-test completeness. This suite fills the
// genuine gaps left by the per-phase suites (DurableLogSync = Phase 2, SpaceRegister
// = Phase 3, CapabilityGate = Phase 4, SpaceRotate = Phase 5):
//
//   (1) HEADLINE removal-E2E: two members A+B both hold a cached gen-0 WRITE scope
//       on OPEN sockets; the admin space-rotates (gen+1). A's subsequent log-entry
//       over its STILL-OPEN socket → CAPABILITY_REQUIRED AND the rejected entry is
//       NOT in the durable log (proven by cold reconstruction). Re-presenting the
//       OLD-gen capability → CAPABILITY_GENERATION_STALE; a NEW-gen capability → ok.
//       CONTROL: without the rotation A's follow-up write succeeds.
//   (3b) Author-binding ingest verification: a log-entry JWS whose authorKid claims
//       a FOREIGN DID but is signed with the sender's OWN key fails JWS signature
//       verification → AUTH_INVALID (distinct from the AUTHOR_MISMATCH branch in
//       DurableLogSync, where the signature is valid but the deviceId is foreign).
//   (7) Management-frame routing matrix: a MALFORMED space-register / space-rotate /
//       admin-add / admin-remove / present-capability / device-revoke each →
//       MALFORMED_MESSAGE with NO fall-through into inbox routing (the per-DID inbox
//       queue does NOT grow, nothing is delivered to any recipient). PLUS an unknown
//       control-frame `type` → MALFORMED_MESSAGE (closed top-level vocabulary).

const PORT = 9891
const RELAY_URL = `ws://localhost:${PORT}`
const FIXED_TIMESTAMP = '2026-06-23T10:00:00Z'
const CAP_ISSUED_AT = '2026-01-01T00:00:00Z'
const CAP_VALID_UNTIL = '2099-01-01T00:00:00Z'

const cryptoAdapter = new WebCryptoProtocolCryptoAdapter()
const {
  buildBrokerAuthTranscript,
  createBrokerAuthTranscriptSigningBytes,
  formatBrokerChallengeResponseSignature,
  DIDCOMM_PLAINTEXT_TYP,
  SPACE_INVITE_MESSAGE_TYPE,
  SPACE_REGISTER_MESSAGE_TYPE,
  SPACE_ROTATE_MESSAGE_TYPE,
  ADMIN_ADD_MESSAGE_TYPE,
  ADMIN_REMOVE_MESSAGE_TYPE,
  BROKER_DEVICE_REVOKE_CONTROL_FRAME_TYPE,
} = protocol

const PRESENT_CAPABILITY_CONTROL_FRAME_TYPE = 'present-capability'

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
  const seed = await cryptoAdapter.sha256(new TextEncoder().encode(`acceptance-cg-test/seed/${label}`))
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

// --- log-entry builders -------------------------------------------------------
//
// `authorKidOverride` lets the (3b) test mint a payload whose authorKid claims a
// FOREIGN DID while the JWS is signed with `signingSeed` (the sender's OWN key);
// createLogEntryJws sets header.kid = payload.authorKid, so the broker resolves the
// FOREIGN public key from the kid and the OWN signature fails verification.

async function buildLogEntryJws(params: {
  identity: RawIdentity
  docId: string
  seq: number
  plaintext: string
  generation?: number
  deviceId?: string
  authorKidOverride?: string
}): Promise<string> {
  const generation = params.generation ?? 0
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
    authorKid: params.authorKidOverride ?? params.identity.authorKid,
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

function syncRequestEnvelope(from: string, docId: string, heads: Record<string, number>): Record<string, unknown> {
  return protocol.createSyncRequestMessage({
    id: randomUUID(),
    from,
    createdTime: Math.floor(Date.now() / 1000),
    body: { docId, heads },
  }) as unknown as Record<string, unknown>
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

// --- minimal authenticated relay client over ws ------------------------------

type SendOutcome = Record<string, unknown> | { error: string; clientHint?: string }

class TestClient {
  private ws: WebSocket | null = null
  readonly messages: Record<string, unknown>[] = []
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

const status = (o: SendOutcome) => (o as Record<string, unknown>).status

/** Inspect the server's durable space registry + offline inbox queue (test-only). */
function internals(server: RelayServer): {
  getSpace: (id: string) => { verificationKey: string; generation: number } | null
  queueCount: () => number
} {
  const s = server as unknown as {
    docLog: { getSpace: (id: string) => { verificationKey: string; generation: number } | null }
    queue: { count: (did?: string) => number }
  }
  return {
    getSpace: (id) => s.docLog.getSpace(id),
    queueCount: () => s.queue.count(),
  }
}

describe('Acceptance: capability-gate completeness (Slice CG / VE-10)', () => {
  let server: RelayServer

  beforeEach(async () => {
    server = new RelayServer({ port: PORT })
    await server.start()
  })

  afterEach(async () => {
    await server.stop()
  })

  // --- (1) HEADLINE removal-E2E ----------------------------------------------

  it('HEADLINE removal-E2E (A+B): admin rotates → A`s open-socket write is CAPABILITY_REQUIRED AND absent from the durable log; old-gen re-present → STALE; new-gen → ok', async () => {
    // Two members A and B both hold a cached gen-0 WRITE scope on OPEN sockets and
    // each write once (so the log has real prior content). The admin then rotates the
    // Space Capability key (gen 0 → 1) — the member-removal mechanism. A`s cached
    // gen-0 scope is invalidated IMMEDIATELY across its still-open socket, so its
    // next write WITHOUT re-presenting fails CAPABILITY_REQUIRED, and crucially the
    // rejected entry is NOT persisted (cold reconstruction recovers only the two
    // pre-rotation writes). Re-presenting the OLD gen-0 capability → STALE; a gen-1
    // capability (minted against the NEW key) restores write access.
    const docId = randomUUID()
    const admin = await makeRawIdentity('hl-admin')
    const memberA = await makeRawIdentity('hl-memberA')
    const memberB = await makeRawIdentity('hl-memberB')
    const reader = await makeRawIdentity('hl-reader')
    const gen0 = await makeSpaceCapabilityKeypair()

    const adminClient = new TestClient(admin)
    const aClient = new TestClient(memberA)
    const bClient = new TestClient(memberB)
    await adminClient.connect()
    await aClient.connect()
    await bClient.connect()

    // Register the space at gen 0 (admin = admin.did).
    expect(
      status(
        await adminClient.sendSpaceRegister({
          signer: admin,
          spaceId: docId,
          spaceCapabilityVerificationKey: gen0.verificationKey,
          adminDids: [admin.did],
        }),
      ),
    ).toBe('delivered')

    // A and B each present a gen-0 WRITE capability and write once → both stored.
    const capA0 = await mintSpaceCapability({ keypair: gen0, spaceId: docId, audience: memberA.did, permissions: ['read', 'write'], generation: 0 })
    const capB0 = await mintSpaceCapability({ keypair: gen0, spaceId: docId, audience: memberB.did, permissions: ['read', 'write'], generation: 0 })
    expect(status(await aClient.presentCapability(capA0))).toBe('delivered')
    expect(status(await bClient.presentCapability(capB0))).toBe('delivered')

    const a0 = await buildLogEntryJws({ identity: memberA, docId, seq: 0, plaintext: 'A-before' })
    const b0 = await buildLogEntryJws({ identity: memberB, docId, seq: 0, plaintext: 'B-before' })
    expect(status(await aClient.send(logEntryEnvelope(memberA.did, [reader.did], a0)))).toBe('delivered')
    expect(status(await bClient.send(logEntryEnvelope(memberB.did, [reader.did], b0)))).toBe('delivered')

    // Admin rotates to gen 1 with a NEW verification key (removal of, say, A).
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
    expect(internals(server).getSpace(docId)?.generation).toBe(1)

    // A`s gen-0 scope is invalidated IMMEDIATELY: its next write on the SAME open
    // socket — WITHOUT re-presenting — is rejected CAPABILITY_REQUIRED.
    const aAfter = await buildLogEntryJws({ identity: memberA, docId, seq: 1, plaintext: 'A-after-rotate' })
    expect(await aClient.send(logEntryEnvelope(memberA.did, [reader.did], aAfter))).toMatchObject({
      error: 'CAPABILITY_REQUIRED',
    })

    // Re-presenting the OLD gen-0 capability → CAPABILITY_GENERATION_STALE.
    expect(await aClient.presentCapability(capA0)).toMatchObject({ error: 'CAPABILITY_GENERATION_STALE' })

    // A gen-1 capability (minted against the NEW key) verifies → write succeeds again.
    const capA1 = await mintSpaceCapability({ keypair: gen1, spaceId: docId, audience: memberA.did, permissions: ['read', 'write'], generation: 1 })
    expect(status(await aClient.presentCapability(capA1))).toBe('delivered')
    const aReadmitted = await buildLogEntryJws({ identity: memberA, docId, seq: 1, plaintext: 'A-readmitted', generation: 1 })
    expect(status(await aClient.send(logEntryEnvelope(memberA.did, [reader.did], aReadmitted)))).toBe('delivered')

    await adminClient.disconnect()
    await aClient.disconnect()
    await bClient.disconnect()

    // The rejected gen-0 `A-after-rotate` entry is NOT in the durable log. A fresh
    // reader reconstructs only: A-before, B-before, and the post-readmit gen-1 write.
    const readerClient = new TestClient(reader)
    await readerClient.connect()
    const readerCap = await mintSpaceCapability({ keypair: gen1, spaceId: docId, audience: reader.did, permissions: ['read'], generation: 1 })
    expect(status(await readerClient.presentCapability(readerCap))).toBe('delivered')
    const resp = await readerClient.syncRequest(syncRequestEnvelope(reader.did, docId, {}))
    const body = resp.body as { entries: string[] }
    const plaintexts = (await reconstruct(body.entries, docId)).sort()
    expect(plaintexts).toEqual(['A-before', 'A-readmitted', 'B-before'])
    expect(plaintexts).not.toContain('A-after-rotate')

    await readerClient.disconnect()
  })

  it('CONTROL (no rotation): A`s follow-up write on the open socket succeeds — isolating the rotation as the cause of the headline rejection', async () => {
    const docId = randomUUID()
    const admin = await makeRawIdentity('ctrl-admin')
    const memberA = await makeRawIdentity('ctrl-memberA')
    const reader = await makeRawIdentity('ctrl-reader')
    const gen0 = await makeSpaceCapabilityKeypair()

    const adminClient = new TestClient(admin)
    const aClient = new TestClient(memberA)
    await adminClient.connect()
    await aClient.connect()

    await adminClient.sendSpaceRegister({
      signer: admin,
      spaceId: docId,
      spaceCapabilityVerificationKey: gen0.verificationKey,
      adminDids: [admin.did],
    })
    const capA0 = await mintSpaceCapability({ keypair: gen0, spaceId: docId, audience: memberA.did, permissions: ['read', 'write'], generation: 0 })
    expect(status(await aClient.presentCapability(capA0))).toBe('delivered')

    const a0 = await buildLogEntryJws({ identity: memberA, docId, seq: 0, plaintext: 'A-0' })
    expect(status(await aClient.send(logEntryEnvelope(memberA.did, [reader.did], a0)))).toBe('delivered')
    // NO rotation → the SAME cached gen-0 scope still authorizes a second write.
    const a1 = await buildLogEntryJws({ identity: memberA, docId, seq: 1, plaintext: 'A-1' })
    expect(status(await aClient.send(logEntryEnvelope(memberA.did, [reader.did], a1)))).toBe('delivered')

    await adminClient.disconnect()
    await aClient.disconnect()
  })

  // --- (3b) Author-binding ingest verification: forged authorKid -------------

  it('author-binding (ingest verification): a log-entry whose authorKid claims a FOREIGN DID but is signed with the sender`s OWN key fails JWS verification → AUTH_INVALID', async () => {
    // verifyLogEntryJws resolves the public key from header.kid (== payload.authorKid)
    // and verifies the Ed25519 signature against it. Alice mints an entry whose
    // authorKid claims VICTIM`s DID but signs it with her OWN seed → the signature
    // does not verify under victim`s key → AUTH_INVALID (NOT AUTHOR_MISMATCH, which
    // assumes a valid signature). The entry is never stored.
    const docId = randomUUID()
    const alice = await makeRawIdentity('forge-alice')
    const victim = await makeRawIdentity('forge-victim')
    const reader = await makeRawIdentity('forge-reader')
    const gen0 = await makeSpaceCapabilityKeypair()

    const aliceClient = new TestClient(alice)
    await aliceClient.connect()

    // Alice holds a real WRITE scope so the gate passes and the rejection comes from
    // ingest JWS verification (the check under test), not from a missing capability.
    expect(
      status(
        await aliceClient.sendSpaceRegister({
          signer: alice,
          spaceId: docId,
          spaceCapabilityVerificationKey: gen0.verificationKey,
          adminDids: [alice.did],
        }),
      ),
    ).toBe('delivered')
    const aliceCap = await mintSpaceCapability({ keypair: gen0, spaceId: docId, audience: alice.did, permissions: ['read', 'write'] })
    expect(status(await aliceClient.presentCapability(aliceCap))).toBe('delivered')

    // authorKid claims victim`s DID; the JWS is signed with Alice`s seed → bad sig.
    const forged = await buildLogEntryJws({
      identity: alice,
      docId,
      seq: 0,
      plaintext: 'forged',
      authorKidOverride: `${victim.did}#sig-0`,
    })
    expect(await aliceClient.send(logEntryEnvelope(alice.did, [reader.did], forged))).toMatchObject({
      error: 'AUTH_INVALID',
    })

    await aliceClient.disconnect()

    // Nothing was stored — cold reconstruction is empty.
    const readerClient = new TestClient(reader)
    await readerClient.connect()
    const readerCap = await mintSpaceCapability({ keypair: gen0, spaceId: docId, audience: reader.did, permissions: ['read'] })
    expect(status(await readerClient.presentCapability(readerCap))).toBe('delivered')
    const resp = await readerClient.syncRequest(syncRequestEnvelope(reader.did, docId, {}))
    expect((resp.body as { entries: string[] }).entries).toEqual([])
    await readerClient.disconnect()
  })

  // --- (7) Management-frame MALFORMED matrix + closed vocabulary -------------

  describe('management-frame routing: a malformed frame → MALFORMED_MESSAGE with NO fall-through into inbox routing', () => {
    // For each of the six broker control-frames the relay dispatches at the top level,
    // a malformed shape MUST be rejected with MALFORMED_MESSAGE and MUST NOT fall
    // through to inbox routing — i.e. nothing is enqueued for any recipient and no
    // recipient is delivered a message. We assert that by (a) the error code, (b) the
    // global offline-queue count staying at 0, and (c) a co-connected witness DID
    // receiving no `message`. Each frame carries a well-formed inner JWS but an EXTRA
    // top-level field, which the closed-frame parsers reject structurally (so the
    // rejection is the closed-shape gate, not an auth/crypto failure downstream).

    async function malformedFrameOf(
      sender: RawIdentity,
      spaceId: string,
      kind: string,
    ): Promise<Record<string, unknown>> {
      const vk = (await makeSpaceCapabilityKeypair()).verificationKey
      switch (kind) {
        case SPACE_REGISTER_MESSAGE_TYPE:
          return {
            ...((await protocol.createSpaceRegisterMessage({
              spaceId,
              spaceCapabilityVerificationKey: vk,
              adminDids: [sender.did],
              kid: sender.authorKid,
              signingSeed: sender.seed,
            })) as unknown as Record<string, unknown>),
            thid: randomUUID(),
          }
        case SPACE_ROTATE_MESSAGE_TYPE:
          return {
            ...((await protocol.createSpaceRotateMessage({
              spaceId,
              newSpaceCapabilityVerificationKey: vk,
              newGeneration: 1,
              kid: sender.authorKid,
              signingSeed: sender.seed,
            })) as unknown as Record<string, unknown>),
            thid: randomUUID(),
          }
        case ADMIN_ADD_MESSAGE_TYPE:
          return {
            ...((await protocol.createAdminAddMessage({
              spaceId,
              newAdminDid: sender.did,
              kid: sender.authorKid,
              signingSeed: sender.seed,
            })) as unknown as Record<string, unknown>),
            thid: randomUUID(),
          }
        case ADMIN_REMOVE_MESSAGE_TYPE:
          return {
            ...((await protocol.createAdminRemoveMessage({
              spaceId,
              removedAdminDid: sender.did,
              kid: sender.authorKid,
              signingSeed: sender.seed,
            })) as unknown as Record<string, unknown>),
            thid: randomUUID(),
          }
        case PRESENT_CAPABILITY_CONTROL_FRAME_TYPE: {
          const cap = await mintSpaceCapability({
            keypair: await makeSpaceCapabilityKeypair(),
            spaceId,
            audience: sender.did,
            permissions: ['read', 'write'],
          })
          return { type: PRESENT_CAPABILITY_CONTROL_FRAME_TYPE, capabilityJws: cap, thid: randomUUID() }
        }
        case BROKER_DEVICE_REVOKE_CONTROL_FRAME_TYPE: {
          const payload = { type: 'device-revoke', did: sender.did, deviceId: sender.deviceId, revokedAt: FIXED_TIMESTAMP }
          const revocationJws = await protocol.createJcsEd25519Jws(
            { alg: 'EdDSA', kid: sender.authorKid },
            payload as unknown as protocol.JsonValue,
            sender.seed,
          )
          return { type: BROKER_DEVICE_REVOKE_CONTROL_FRAME_TYPE, revocationJws, thid: randomUUID() }
        }
        default:
          throw new Error(`unknown frame kind ${kind}`)
      }
    }

    const frames = [
      SPACE_REGISTER_MESSAGE_TYPE,
      SPACE_ROTATE_MESSAGE_TYPE,
      ADMIN_ADD_MESSAGE_TYPE,
      ADMIN_REMOVE_MESSAGE_TYPE,
      PRESENT_CAPABILITY_CONTROL_FRAME_TYPE,
      BROKER_DEVICE_REVOKE_CONTROL_FRAME_TYPE,
    ]

    for (const kind of frames) {
      it(`${kind}: malformed → MALFORMED_MESSAGE, queue does not grow, witness receives nothing`, async () => {
        const spaceId = randomUUID()
        const sender = await makeRawIdentity(`mm-sender-${kind}`)
        const witness = await makeRawIdentity(`mm-witness-${kind}`)

        const senderClient = new TestClient(sender)
        const witnessClient = new TestClient(witness)
        await senderClient.connect()
        await witnessClient.connect()

        expect(internals(server).queueCount()).toBe(0)

        const frame = await malformedFrameOf(sender, spaceId, kind)
        expect(await senderClient.sendControlFrame(frame)).toMatchObject({ error: 'MALFORMED_MESSAGE' })

        // No fall-through into inbox routing: nothing was enqueued for anyone, and the
        // co-connected witness was not delivered any `message`.
        expect(internals(server).queueCount()).toBe(0)
        expect(witnessClient.messages).toHaveLength(0)

        await senderClient.disconnect()
        await witnessClient.disconnect()
      })
    }

    it('unknown control-frame `type` → MALFORMED_MESSAGE (closed top-level vocabulary), no inbox fall-through', async () => {
      const sender = await makeRawIdentity('mm-unknown-sender')
      const witness = await makeRawIdentity('mm-unknown-witness')
      const senderClient = new TestClient(sender)
      const witnessClient = new TestClient(witness)
      await senderClient.connect()
      await witnessClient.connect()

      // A made-up top-level type that is NOT in the dispatch vocabulary — even one
      // shaped like a DIDComm envelope addressed to the witness — is rejected, NOT
      // routed to the witness.
      expect(
        await senderClient.sendControlFrame({
          type: 'totally-unknown-frame',
          to: [witness.did],
          body: { hello: 'world' },
        }),
      ).toMatchObject({ error: 'MALFORMED_MESSAGE' })

      expect(internals(server).queueCount()).toBe(0)
      expect(witnessClient.messages).toHaveLength(0)

      await senderClient.disconnect()
      await witnessClient.disconnect()
    })
  })
})
