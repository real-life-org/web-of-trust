import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { randomUUID, randomBytes } from 'crypto'
import WebSocket from 'ws'
import { RelayServer } from '../src/relay.js'
import type { RelayMessage } from '../src/types.js'
import { protocol, WebCryptoProtocolCryptoAdapter } from '@web_of_trust/core'

// Slice CG / Phase 5 (VE-6 + VE-7) — the `space-rotate` control-frame with
// immediate cross-socket capability-scope invalidation (the security-critical
// member-removal mechanism), plus `admin-add` / `admin-remove`
// (Sync 003 §Capability-Widerruf über Rotation + §Admin-Management).
//
// space-rotate: an admin rotates the Space Capability key + bumps the generation
// (newGeneration == current+1 EXACTLY). The broker MUST immediately invalidate
// every cached capability scope of an OLDER generation for that spaceId across ALL
// open WebSockets of ALL DIDs, so a just-removed member cannot keep writing on a
// still-open socket. A stale (old-gen) re-presentation → CAPABILITY_GENERATION_STALE.
//
// admin-add / admin-remove: signed by a CURRENTLY registered admin (else
// AUTH_INVALID); they mutate the durable admin set used by the rotate authz.

const PORT = 9890
const RELAY_URL = `ws://localhost:${PORT}`
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
  const seed = await cryptoAdapter.sha256(new TextEncoder().encode(`space-rotate-test/seed/${label}`))
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
    timestamp: '2026-06-23T10:00:00Z',
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
            // Capture `thid` (SR-4 / F1): control-frame error frames carry thid == docId
            // so the client can correlate a hard reject to its in-flight control-frame waiter.
            if (waiter) waiter({ error: msg.code, clientHint: msg.clientHint, thid: msg.thid })
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

  async sendAdminAdd(params: {
    signer: RawIdentity
    spaceId: string
    newAdminDid: string
  }): Promise<SendOutcome> {
    const frame = await protocol.createAdminAddMessage({
      spaceId: params.spaceId,
      newAdminDid: params.newAdminDid,
      kid: params.signer.authorKid,
      signingSeed: params.signer.seed,
    })
    return this.sendControlFrame(frame as unknown as Record<string, unknown>)
  }

  async sendAdminRemove(params: {
    signer: RawIdentity
    spaceId: string
    removedAdminDid: string
  }): Promise<SendOutcome> {
    const frame = await protocol.createAdminRemoveMessage({
      spaceId: params.spaceId,
      removedAdminDid: params.removedAdminDid,
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

/** Inspect the server's durable space registry (test-only). */
function docLogOf(server: RelayServer): {
  getSpace: (id: string) => { verificationKey: string; generation: number } | null
  getSpaceAdmins: (id: string) => string[]
} {
  const internal = server as unknown as {
    docLog: {
      getSpace: (id: string) => { verificationKey: string; generation: number } | null
      getSpaceAdmins: (id: string) => string[]
    }
  }
  return {
    getSpace: (id) => internal.docLog.getSpace(id),
    getSpaceAdmins: (id) => internal.docLog.getSpaceAdmins(id),
  }
}

const status = (o: SendOutcome) => (o as Record<string, unknown>).status

describe('space-rotate + admin-add/remove over the real relay (Slice CG / VE-6 + VE-7)', () => {
  let server: RelayServer

  beforeEach(async () => {
    server = new RelayServer({ port: PORT })
    await server.start()
  })

  afterEach(async () => {
    await server.stop()
  })

  it('ROTATION-DRIVEN STALE: rotate invalidates a member gen-0 scope across the open socket; re-present gen-0 → STALE; gen-1 → write succeeds', async () => {
    // The end-to-end security path: a member holds a gen-0 write scope on an open
    // socket and writes. The admin rotates (gen-1, new verification key). The
    // member's cached gen-0 scope is invalidated IMMEDIATELY across the open socket,
    // so its next write fails CAPABILITY_REQUIRED; re-presenting the gen-0 cap fails
    // CAPABILITY_GENERATION_STALE; only a gen-1 cap (minted against the NEW key)
    // restores write access.
    const docId = randomUUID()
    const admin = await makeRawIdentity('rot-admin')
    const member = await makeRawIdentity('rot-member')
    const gen0 = await makeSpaceCapabilityKeypair()

    const adminClient = new TestClient(admin)
    const memberClient = new TestClient(member)
    await adminClient.connect()
    await memberClient.connect()

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

    // Member presents a gen-0 write capability and writes (ok).
    const memberCap0 = await mintSpaceCapability({
      keypair: gen0,
      spaceId: docId,
      audience: member.did,
      permissions: ['read', 'write'],
      generation: 0,
    })
    expect(status(await memberClient.presentCapability(memberCap0))).toBe('delivered')
    const jws0 = await buildLogEntryJws({ identity: member, docId, seq: 0, plaintext: 'gen0-before-rotate' })
    expect(status(await memberClient.send(logEntryEnvelope(member.did, [admin.did], jws0)))).toBe('delivered')

    // Admin rotates to gen 1 with a NEW verification key (member-removal mechanism).
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
    expect(docLogOf(server).getSpace(docId)?.generation).toBe(1)
    expect(docLogOf(server).getSpace(docId)?.verificationKey).toBe(gen1.verificationKey)

    // The member's cached gen-0 scope was invalidated IMMEDIATELY: its next write on
    // the SAME still-open socket is rejected CAPABILITY_REQUIRED (the just-removed
    // member can no longer write). The capability gate runs BEFORE the VE-R1
    // generations-gate, so this rejection fires regardless of the entry's
    // keyGeneration. The entry itself is built at the NEW keyGeneration 1 (the
    // legitimate post-rotation re-emit) so the same JWS can also prove a successful
    // write once a gen-1 capability is presented below.
    const jws1 = await buildLogEntryJws({
      identity: member,
      docId,
      seq: 1,
      plaintext: 'gen1-after-rotate',
      keyGeneration: 1,
    })
    expect(await memberClient.send(logEntryEnvelope(member.did, [admin.did], jws1))).toMatchObject({
      error: 'CAPABILITY_REQUIRED',
    })

    // Re-presenting the OLD gen-0 capability is rejected CAPABILITY_GENERATION_STALE.
    expect(await memberClient.presentCapability(memberCap0)).toMatchObject({
      error: 'CAPABILITY_GENERATION_STALE',
    })

    // A gen-1 capability (minted against the NEW key) verifies → write succeeds again.
    const memberCap1 = await mintSpaceCapability({
      keypair: gen1,
      spaceId: docId,
      audience: member.did,
      permissions: ['read', 'write'],
      generation: 1,
    })
    expect(status(await memberClient.presentCapability(memberCap1))).toBe('delivered')
    expect(status(await memberClient.send(logEntryEnvelope(member.did, [admin.did], jws1)))).toBe('delivered')

    await adminClient.disconnect()
    await memberClient.disconnect()
  })

  it('CONTROL (no rotation): a member gen-0 write scope keeps working when no space-rotate happens', async () => {
    // Mirror of the STALE test WITHOUT the rotate: the gen-0 scope is never
    // invalidated, so repeated writes on the open socket keep succeeding. This isolates
    // the invalidation as the cause of the CAPABILITY_REQUIRED in the rotation test.
    const docId = randomUUID()
    const admin = await makeRawIdentity('noctrl-admin')
    const member = await makeRawIdentity('noctrl-member')
    const gen0 = await makeSpaceCapabilityKeypair()

    const adminClient = new TestClient(admin)
    const memberClient = new TestClient(member)
    await adminClient.connect()
    await memberClient.connect()

    await adminClient.sendSpaceRegister({
      signer: admin,
      spaceId: docId,
      spaceCapabilityVerificationKey: gen0.verificationKey,
      adminDids: [admin.did],
    })
    const memberCap0 = await mintSpaceCapability({
      keypair: gen0,
      spaceId: docId,
      audience: member.did,
      permissions: ['read', 'write'],
      generation: 0,
    })
    expect(status(await memberClient.presentCapability(memberCap0))).toBe('delivered')

    const jws0 = await buildLogEntryJws({ identity: member, docId, seq: 0, plaintext: 'ctrl-0' })
    expect(status(await memberClient.send(logEntryEnvelope(member.did, [admin.did], jws0)))).toBe('delivered')
    // No rotate → the SAME scope still authorizes a second write.
    const jws1 = await buildLogEntryJws({ identity: member, docId, seq: 1, plaintext: 'ctrl-1' })
    expect(status(await memberClient.send(logEntryEnvelope(member.did, [admin.did], jws1)))).toBe('delivered')

    await adminClient.disconnect()
    await memberClient.disconnect()
  })

  it('space-rotate rejects a non-admin signer with AUTH_INVALID (and does not bump the generation)', async () => {
    const docId = randomUUID()
    const admin = await makeRawIdentity('auth-admin')
    const stranger = await makeRawIdentity('auth-stranger')
    const gen0 = await makeSpaceCapabilityKeypair()

    const adminClient = new TestClient(admin)
    const strangerClient = new TestClient(stranger)
    await adminClient.connect()
    await strangerClient.connect()

    await adminClient.sendSpaceRegister({
      signer: admin,
      spaceId: docId,
      spaceCapabilityVerificationKey: gen0.verificationKey,
      adminDids: [admin.did],
    })

    // Stranger (not in the admin set) signs a rotate → AUTH_INVALID.
    const gen1 = await makeSpaceCapabilityKeypair()
    expect(
      await strangerClient.sendSpaceRotate({
        signer: stranger,
        spaceId: docId,
        newSpaceCapabilityVerificationKey: gen1.verificationKey,
        newGeneration: 1,
      }),
    ).toMatchObject({ error: 'AUTH_INVALID', thid: docId }) // SR-4 / F1: reject carries thid==docId
    // Generation untouched.
    expect(docLogOf(server).getSpace(docId)?.generation).toBe(0)
    expect(docLogOf(server).getSpace(docId)?.verificationKey).toBe(gen0.verificationKey)

    await adminClient.disconnect()
    await strangerClient.disconnect()
  })

  it('space-rotate rejects newGeneration != current+1 (skip-ahead AND repeat) with AUTH_INVALID', async () => {
    const docId = randomUUID()
    const admin = await makeRawIdentity('gen-admin')
    const gen0 = await makeSpaceCapabilityKeypair()
    const adminClient = new TestClient(admin)
    await adminClient.connect()

    await adminClient.sendSpaceRegister({
      signer: admin,
      spaceId: docId,
      spaceCapabilityVerificationKey: gen0.verificationKey,
      adminDids: [admin.did],
    })

    // newGeneration = 2 from current 0 (skip ahead) → AUTH_INVALID, no change.
    const skip = await makeSpaceCapabilityKeypair()
    expect(
      await adminClient.sendSpaceRotate({
        signer: admin,
        spaceId: docId,
        newSpaceCapabilityVerificationKey: skip.verificationKey,
        newGeneration: 2,
      }),
    ).toMatchObject({ error: 'AUTH_INVALID', thid: docId }) // SR-4 / F1: thid==docId on the mismatch reject
    expect(docLogOf(server).getSpace(docId)?.generation).toBe(0)

    // newGeneration = 0 (== current, not +1) → AUTH_INVALID.
    expect(
      await adminClient.sendSpaceRotate({
        signer: admin,
        spaceId: docId,
        newSpaceCapabilityVerificationKey: skip.verificationKey,
        newGeneration: 0,
      }),
    ).toMatchObject({ error: 'AUTH_INVALID', thid: docId }) // SR-4 / F1: thid==docId on the repeat-gen reject
    expect(docLogOf(server).getSpace(docId)?.generation).toBe(0)
    expect(docLogOf(server).getSpace(docId)?.verificationKey).toBe(gen0.verificationKey)

    await adminClient.disconnect()
  })

  it('space-rotate rejects a malformed outer frame with MALFORMED_MESSAGE', async () => {
    const docId = randomUUID()
    const admin = await makeRawIdentity('malformed-admin')
    const gen0 = await makeSpaceCapabilityKeypair()
    const adminClient = new TestClient(admin)
    await adminClient.connect()

    await adminClient.sendSpaceRegister({
      signer: admin,
      spaceId: docId,
      spaceCapabilityVerificationKey: gen0.verificationKey,
      adminDids: [admin.did],
    })

    // A well-formed rotation JWS but an EXTRA top-level field → closed-frame violation.
    const gen1 = await makeSpaceCapabilityKeypair()
    const valid = await protocol.createSpaceRotateMessage({
      spaceId: docId,
      newSpaceCapabilityVerificationKey: gen1.verificationKey,
      newGeneration: 1,
      kid: admin.authorKid,
      signingSeed: admin.seed,
    })
    expect(
      await adminClient.sendControlFrame({ ...(valid as unknown as Record<string, unknown>), thid: randomUUID() }),
    ).toMatchObject({ error: 'MALFORMED_MESSAGE' })
    expect(docLogOf(server).getSpace(docId)?.generation).toBe(0)

    await adminClient.disconnect()
  })

  it('space-rotate for an UNREGISTERED space is rejected with DOC_NOT_FOUND', async () => {
    const docId = randomUUID() // never registered
    const admin = await makeRawIdentity('unreg-admin')
    const gen1 = await makeSpaceCapabilityKeypair()
    const adminClient = new TestClient(admin)
    await adminClient.connect()

    expect(
      await adminClient.sendSpaceRotate({
        signer: admin,
        spaceId: docId,
        newSpaceCapabilityVerificationKey: gen1.verificationKey,
        newGeneration: 1,
      }),
    ).toMatchObject({ error: 'DOC_NOT_FOUND' })

    await adminClient.disconnect()
  })

  it('admin-add: an existing admin adds a new admin who can then sign a successful space-rotate', async () => {
    const docId = randomUUID()
    const admin = await makeRawIdentity('add-admin')
    const newAdmin = await makeRawIdentity('add-newadmin')
    const gen0 = await makeSpaceCapabilityKeypair()

    const adminClient = new TestClient(admin)
    const newAdminClient = new TestClient(newAdmin)
    await adminClient.connect()
    await newAdminClient.connect()

    await adminClient.sendSpaceRegister({
      signer: admin,
      spaceId: docId,
      spaceCapabilityVerificationKey: gen0.verificationKey,
      adminDids: [admin.did],
    })

    // Before the add, newAdmin cannot rotate (not a registered admin).
    const pre = await makeSpaceCapabilityKeypair()
    expect(
      await newAdminClient.sendSpaceRotate({
        signer: newAdmin,
        spaceId: docId,
        newSpaceCapabilityVerificationKey: pre.verificationKey,
        newGeneration: 1,
      }),
    ).toMatchObject({ error: 'AUTH_INVALID' })

    // Existing admin adds newAdmin.
    expect(
      status(await adminClient.sendAdminAdd({ signer: admin, spaceId: docId, newAdminDid: newAdmin.did })),
    ).toBe('delivered')
    expect(docLogOf(server).getSpaceAdmins(docId)).toContain(newAdmin.did)

    // newAdmin can now sign a successful rotate.
    const gen1 = await makeSpaceCapabilityKeypair()
    expect(
      status(
        await newAdminClient.sendSpaceRotate({
          signer: newAdmin,
          spaceId: docId,
          newSpaceCapabilityVerificationKey: gen1.verificationKey,
          newGeneration: 1,
        }),
      ),
    ).toBe('delivered')
    expect(docLogOf(server).getSpace(docId)?.generation).toBe(1)

    await adminClient.disconnect()
    await newAdminClient.disconnect()
  })

  it('admin-add by a non-admin is rejected with AUTH_INVALID (admin set unchanged)', async () => {
    const docId = randomUUID()
    const admin = await makeRawIdentity('addnoauth-admin')
    const stranger = await makeRawIdentity('addnoauth-stranger')
    const victim = await makeRawIdentity('addnoauth-victim')
    const gen0 = await makeSpaceCapabilityKeypair()

    const adminClient = new TestClient(admin)
    const strangerClient = new TestClient(stranger)
    await adminClient.connect()
    await strangerClient.connect()

    await adminClient.sendSpaceRegister({
      signer: admin,
      spaceId: docId,
      spaceCapabilityVerificationKey: gen0.verificationKey,
      adminDids: [admin.did],
    })

    // Stranger tries to promote `victim` → AUTH_INVALID; nothing changes.
    expect(
      await strangerClient.sendAdminAdd({ signer: stranger, spaceId: docId, newAdminDid: victim.did }),
    ).toMatchObject({ error: 'AUTH_INVALID' })
    expect(docLogOf(server).getSpaceAdmins(docId)).toEqual([admin.did])

    await adminClient.disconnect()
    await strangerClient.disconnect()
  })

  it('admin-remove: an admin removes another admin; the removed admin can no longer space-rotate (AUTH_INVALID)', async () => {
    const docId = randomUUID()
    const adminA = await makeRawIdentity('rm-adminA')
    const adminB = await makeRawIdentity('rm-adminB')
    const gen0 = await makeSpaceCapabilityKeypair()

    const aClient = new TestClient(adminA)
    const bClient = new TestClient(adminB)
    await aClient.connect()
    await bClient.connect()

    // Register with BOTH as admins.
    await aClient.sendSpaceRegister({
      signer: adminA,
      spaceId: docId,
      spaceCapabilityVerificationKey: gen0.verificationKey,
      adminDids: [adminA.did, adminB.did],
    })
    expect(docLogOf(server).getSpaceAdmins(docId).sort()).toEqual([adminA.did, adminB.did].sort())

    // adminA removes adminB.
    expect(
      status(await aClient.sendAdminRemove({ signer: adminA, spaceId: docId, removedAdminDid: adminB.did })),
    ).toBe('delivered')
    expect(docLogOf(server).getSpaceAdmins(docId)).toEqual([adminA.did])

    // adminB's subsequent space-rotate is now AUTH_INVALID (no longer a registered admin).
    const gen1 = await makeSpaceCapabilityKeypair()
    expect(
      await bClient.sendSpaceRotate({
        signer: adminB,
        spaceId: docId,
        newSpaceCapabilityVerificationKey: gen1.verificationKey,
        newGeneration: 1,
      }),
    ).toMatchObject({ error: 'AUTH_INVALID' })
    expect(docLogOf(server).getSpace(docId)?.generation).toBe(0)

    // adminA (still an admin) can still rotate.
    expect(
      status(
        await aClient.sendSpaceRotate({
          signer: adminA,
          spaceId: docId,
          newSpaceCapabilityVerificationKey: gen1.verificationKey,
          newGeneration: 1,
        }),
      ),
    ).toBe('delivered')

    await aClient.disconnect()
    await bClient.disconnect()
  })
})
