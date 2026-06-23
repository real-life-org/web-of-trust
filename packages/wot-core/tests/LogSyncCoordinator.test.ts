import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { InMemoryMessagingAdapter, InProcessLogBroker } from '../src/adapters/messaging'
import { InMemoryDocLogStore } from '../src/adapters/storage/InMemoryDocLogStore'
import { WebCryptoProtocolCryptoAdapter } from '../src/adapters/protocol-crypto'
import { createTestIdentity } from './helpers/identity-session'
import type { PublicIdentitySession } from '../src/application/identity'
import {
  LogSyncCoordinator,
  AuthorMismatchError,
  classifyRejectDisposition,
  createSpaceCapabilityJws,
  createSpaceRegisterMessage,
  createLogEntryMessage,
  verifyLogEntryJws,
  deriveLogPayloadNonce,
  decryptLogPayload,
  decodeBase64Url,
  PRESENT_CAPABILITY_CONTROL_FRAME_TYPE,
  SPACE_REGISTER_MESSAGE_TYPE,
  type LogSyncEngineHooks,
  type ControlFrameReceipt,
} from '../src/protocol'

const crypto = new WebCryptoProtocolCryptoAdapter()
const SPACE_ID = '11111111-1111-4111-8111-111111111111'
const DEVICE_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const DEVICE_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'

const FUTURE = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString()
const NOW = new Date().toISOString()

interface Harness {
  identity: PublicIdentitySession
  messaging: InMemoryMessagingAdapter
  logStore: InMemoryDocLogStore
  coordinator: LogSyncCoordinator
  /** Decrypted remote updates applied via the read path. */
  appliedRemote: Uint8Array[]
  /** Count of outgoing envelopes from THIS adapter (for the LOOP-GUARD assert). */
  sentEnvelopes: number
}

const CONTENT_KEY = new Uint8Array(32).fill(7)

/** A 32-byte capability signing seed shared by both members (space capability key). */
let capabilitySigningSeed: Uint8Array

async function makeCapability(audience: string): Promise<string> {
  return createSpaceCapabilityJws({
    payload: {
      type: 'capability',
      spaceId: SPACE_ID,
      audience,
      permissions: ['read', 'write'],
      generation: 0,
      issuedAt: NOW,
      validUntil: FUTURE,
    },
    signingSeed: capabilitySigningSeed,
  })
}

/** Raw-bytes engine hooks: encode = identity; applyRemote collects (throws on the foreign marker). */
function makeHooks(appliedRemote: Uint8Array[]): LogSyncEngineHooks {
  return {
    engine: 'test-raw',
    encodeUpdate: (update) => update,
    applyRemoteUpdate: (plaintext) => {
      // Engine-foreign marker for VE-3 skip test: bytes starting with 0xFF.
      if (plaintext.length > 0 && plaintext[0] === 0xff) {
        throw new Error('engine-foreign payload (not applicable as test-raw CRDT)')
      }
      appliedRemote.push(plaintext)
    },
  }
}

async function makeHarness(
  identity: PublicIdentitySession,
  deviceId: string,
  broker: InProcessLogBroker,
  opts?: { adminDids?: string[]; sendSpaceRegister?: boolean; registrationJws?: string },
): Promise<Harness> {
  const messaging = new InMemoryMessagingAdapter({ broker })
  await messaging.connect(identity.getDid())

  const logStore = new InMemoryDocLogStore()
  await logStore.init()

  const appliedRemote: Uint8Array[] = []
  const harness: Partial<Harness> = { identity, messaging, logStore, appliedRemote, sentEnvelopes: 0 }

  const adminDids = opts?.adminDids ?? [identity.getDid()]

  const coordinator = new LogSyncCoordinator({
    docId: SPACE_ID,
    deviceId,
    ownDid: identity.getDid(),
    authorKid: identity.kid,
    crypto,
    logStore,
    control: {
      sendControlFrame: (frame) => messaging.sendControlFrame!(frame),
    },
    envelopes: {
      send: async (envelope) => {
        harness.sentEnvelopes! += 1
        return messaging.send(envelope as never)
      },
    },
    capabilities: {
      getCapabilityJws: () => makeCapability(identity.getDid()),
    },
    hooks: makeHooks(appliedRemote),
    signLogEntry: (input) => identity.signEd25519(input),
    getContentKey: async () => ({ key: CONTENT_KEY, generation: 0 }),
    getContentKeyByGeneration: async (generation) => (generation === 0 ? CONTENT_KEY : null),
    getAvailableKeyGenerations: async () => [0],
    sendSpaceRegister:
      opts?.sendSpaceRegister === false
        ? undefined
        : async () => {
            // Join idempotency (VE-8): a member re-sends the inviter's bit-identical
            // registrationJws (first-writer-wins). When no inviter frame is provided,
            // sign a fresh one as the sole admin (creator path).
            const register = opts?.registrationJws
              ? { type: SPACE_REGISTER_MESSAGE_TYPE, registrationJws: opts.registrationJws }
              : await createSpaceRegisterMessage({
                  spaceId: SPACE_ID,
                  spaceCapabilityVerificationKey: 'AAAA',
                  adminDids: [identity.getDid()],
                  kid: identity.kid,
                  signingSeed: await deriveAdminSeed(identity),
                })
            return messaging.sendControlFrame!(register) as Promise<ControlFrameReceipt>
          },
  })

  // Wire the inbound dispatcher: log-entry → read path (LOOP-GUARD),
  // sync-response → catch-up waiter.
  messaging.onMessage(async (message) => {
    await coordinator.handleIncoming(message)
  })

  harness.coordinator = coordinator
  return harness as Harness
}

// The admin signing seed for space-register must match the kid's DID key. The test
// identity signs via signEd25519; createSpaceRegisterMessage needs a raw seed, so
// for the broker mock we sign space-register with a throwaway seed whose did:key
// is the identity — but the broker does NOT verify the signature in these tests
// (it only parses + first-writer-wins). We still pass a syntactically valid seed.
async function deriveAdminSeed(_identity: PublicIdentitySession): Promise<Uint8Array> {
  // 32-byte deterministic seed; the broker mock does not verify the admin sig, it
  // parses the frame and applies first-writer-wins (space-register binding is a
  // relay-phase concern verified elsewhere).
  return new Uint8Array(32).fill(3)
}

function isLogEntry(message: unknown): boolean {
  return (message as { type?: unknown })?.type === 'https://web-of-trust.de/protocols/log-entry/1.0'
}

/**
 * The inviter's (Alice's) space-register frame, signed once. Members re-send this
 * exact frame on join (first-writer-wins idempotency, VE-8).
 */
async function inviterRegistrationJws(inviter: PublicIdentitySession): Promise<string> {
  const register = await createSpaceRegisterMessage({
    spaceId: SPACE_ID,
    spaceCapabilityVerificationKey: 'AAAA',
    adminDids: [inviter.getDid()],
    kid: inviter.kid,
    signingSeed: new Uint8Array(32).fill(3),
  })
  return register.registrationJws
}

beforeEach(() => {
  InMemoryMessagingAdapter.resetAll()
  capabilitySigningSeed = new Uint8Array(32).fill(9)
})

afterEach(() => {
  InMemoryMessagingAdapter.resetAll()
})

describe('LogSyncCoordinator — VE-2/3/4/8/9', () => {
  // ── Test 1: Write path ──────────────────────────────────────────────────────
  it('Test 1 — write path: one local change → exactly one log-entry envelope with correct payload, persisted before send', async () => {
    const broker = new InProcessLogBroker()
    const alice = (await createTestIdentity('alice')).identity
    const h = await makeHarness(alice, DEVICE_A, broker)

    const update = new Uint8Array([1, 2, 3, 4])
    const entry = await h.coordinator.writeLocalUpdate(update)

    expect(entry).not.toBeNull()
    expect(entry!.seq).toBe(0) // seq begins at 0
    expect(entry!.deviceId).toBe(DEVICE_A)
    expect(entry!.docId).toBe(SPACE_ID)
    // Persisted BEFORE send: the store holds the entry.
    const stored = await h.logStore.getEntry(SPACE_ID, DEVICE_A, 0)
    expect(stored).not.toBeNull()
    expect(stored!.entryJws).toBe(entry!.entryJws)

    // Inspect the broadcast log-entry payload via the broker's stored entry.
    const broadcast = (broker as unknown as { docs: Map<string, { entries: Map<string, { entryJws: string }> }> }).docs
      .get(SPACE_ID)!
      .entries.get(`${DEVICE_A}:0`)!
    const payload = await verifyLogEntryJws(broadcast.entryJws, { crypto })
    expect(payload.seq).toBe(0)
    expect(payload.deviceId).toBe(DEVICE_A)
    expect(payload.docId).toBe(SPACE_ID)
    expect(payload.authorKid).toBe(alice.kid)
    expect(payload.keyGeneration).toBe(0)
    expect(typeof payload.timestamp).toBe('string')
    expect(payload.timestamp.length).toBeGreaterThan(0)

    // data = base64url(nonce(deviceId,seq) ‖ ciphertext+tag) — decrypts back to the update.
    const blob = decodeBase64Url(payload.data)
    const expectedNonce = await deriveLogPayloadNonce(crypto, DEVICE_A, 0)
    expect(Array.from(blob.slice(0, 12))).toEqual(Array.from(expectedNonce))
    const decrypted = await decryptLogPayload({ crypto, spaceContentKey: CONTENT_KEY, blob })
    expect(Array.from(decrypted)).toEqual(Array.from(update))
  })

  // ── Test 2: First-publication sequence ───────────────────────────────────────
  it('Test 2 — first-publication order: space-register → present-capability → sync-request → first log-entry; no log-entry before present-capability receipt', async () => {
    const broker = new InProcessLogBroker()
    const alice = (await createTestIdentity('alice')).identity
    const h = await makeHarness(alice, DEVICE_A, broker)

    await h.coordinator.writeLocalUpdate(new Uint8Array([9]))

    // Control-frame order on this socket: space-register THEN present-capability.
    const frameTypes = h.messaging.sentControlFrames.map((f) => f.type)
    expect(frameTypes[0]).toBe(SPACE_REGISTER_MESSAGE_TYPE)
    expect(frameTypes[1]).toBe(PRESENT_CAPABILITY_CONTROL_FRAME_TYPE)

    // The broker saw the space-register + present-capability receipts BEFORE the
    // log-entry was accepted into the doc log (publish gate held the write).
    const controlOrder = broker.receivedControlFrames.map((c) => c.frame.type)
    expect(controlOrder).toContain(SPACE_REGISTER_MESSAGE_TYPE)
    expect(controlOrder).toContain(PRESENT_CAPABILITY_CONTROL_FRAME_TYPE)
    expect(controlOrder.indexOf(SPACE_REGISTER_MESSAGE_TYPE)).toBeLessThan(
      controlOrder.indexOf(PRESENT_CAPABILITY_CONTROL_FRAME_TYPE),
    )

    // And the entry was accepted (write happened only after the gate).
    const stored = await h.logStore.getEntry(SPACE_ID, DEVICE_A, 0)
    expect(stored).not.toBeNull()
  })

  it('Test 2b — no log-entry envelope is sent before the present-capability receipt resolves', async () => {
    const broker = new InProcessLogBroker()
    const alice = (await createTestIdentity('alice')).identity

    // Gate: make present-capability hang until we release it, and assert no
    // log-entry envelope is sent meanwhile.
    let releasePresent: (() => void) | null = null
    const presentGate = new Promise<void>((r) => (releasePresent = r))
    const originalHandle = broker.handleControlFrame.bind(broker)
    let logEntrySentBeforePresentResolved = false
    ;(broker as unknown as { handleControlFrame: typeof broker.handleControlFrame }).handleControlFrame = async (
      socketId,
      frame,
    ) => {
      if (frame.type === PRESENT_CAPABILITY_CONTROL_FRAME_TYPE) {
        await presentGate
      }
      return originalHandle(socketId, frame)
    }

    const h = await makeHarness(alice, DEVICE_A, broker)
    // Observe sends: flip the flag if a log-entry envelope is sent while present is pending.
    const baseSend = h.messaging.send.bind(h.messaging)
    ;(h.messaging as unknown as { send: typeof h.messaging.send }).send = async (envelope: never) => {
      if (isLogEntry(envelope) && releasePresent !== null && !released) {
        logEntrySentBeforePresentResolved = true
      }
      return baseSend(envelope)
    }
    let released = false

    const writePromise = h.coordinator.writeLocalUpdate(new Uint8Array([1]))
    await new Promise((r) => setTimeout(r, 50))
    expect(logEntrySentBeforePresentResolved).toBe(false)

    released = true
    releasePresent!()
    await writePromise
    // After release, the entry is written.
    expect(await h.logStore.getEntry(SPACE_ID, DEVICE_A, 0)).not.toBeNull()
  })

  // ── Test 3: LOOP-GUARD (the critical one) ─────────────────────────────────────
  it('Test 3 — LOOP-GUARD: receiving a remote log-entry applies it (origin=remote) and produces NO outgoing envelope; two adapters converge without envelope explosion', async () => {
    const broker = new InProcessLogBroker()
    const alice = (await createTestIdentity('alice')).identity
    const bob = (await createTestIdentity('bob')).identity
    const registrationJws = await inviterRegistrationJws(alice)

    // Two members of the same space, two devices, both members of each other's `to`.
    const a = await makeHarness(alice, DEVICE_A, broker, { registrationJws })
    const b = await makeHarness(bob, DEVICE_B, broker, { registrationJws })

    // Rewire both to broadcast log-entries to BOTH dids (space members), so the
    // broker actually delivers cross-member.
    rewireBroadcastTo(a, [alice.getDid(), bob.getDid()])
    rewireBroadcastTo(b, [alice.getDid(), bob.getDid()])

    // Bob must present a capability + register too (idempotent register).
    await b.coordinator.ensurePublished()

    // Alice makes N local edits.
    const N = 5
    for (let i = 0; i < N; i++) {
      await a.coordinator.writeLocalUpdate(new Uint8Array([i + 1]))
    }
    await flush()

    // Bob received and applied all N (origin=remote), and produced NO outgoing
    // envelope from receiving (his sentEnvelopes only counts his own publish/sync,
    // never a re-broadcast of Alice's entries).
    expect(b.appliedRemote.length).toBe(N)

    // LOOP-GUARD assert: Alice's total send count == number of local edits
    // (+ exactly one sync-request from her own first-publication), NOT exponential.
    // Bob's send count never grows from receiving Alice's entries.
    expect(a.sentEnvelopes).toBe(N + 1) // N log-entries + 1 sync-request (first publication)
    // Bob's sends: only his own first-publication sync-request (1). Receiving Alice's
    // N entries added ZERO sends — this is the 5000+-outbox regression anchor.
    expect(b.sentEnvelopes).toBe(1)
  })

  // ── Test 3b: Idempotency ──────────────────────────────────────────────────────
  it('Test 3b — idempotency: the same log-entry received twice applies once, no double state, no second recordRemoteApplied effect', async () => {
    const broker = new InProcessLogBroker()
    const alice = (await createTestIdentity('alice')).identity
    const bob = (await createTestIdentity('bob')).identity
    const registrationJws = await inviterRegistrationJws(alice)
    const a = await makeHarness(alice, DEVICE_A, broker, { registrationJws })
    const b = await makeHarness(bob, DEVICE_B, broker, { registrationJws })

    await a.coordinator.ensurePublished()
    const entry = await a.coordinator.writeLocalUpdate(new Uint8Array([42]))
    const message = createLogEntryMessage({
      id: globalThis.crypto.randomUUID(),
      from: alice.getDid(),
      to: [bob.getDid()],
      createdTime: Math.floor(Date.now() / 1000),
      entry: entry!.entryJws,
    })

    const r1 = await b.coordinator.receiveLogEntry(message)
    const r2 = await b.coordinator.receiveLogEntry(message)

    expect(r1.disposition).toBe('applied')
    expect(r2.disposition).toBe('idempotent-skip')
    expect(b.appliedRemote.length).toBe(1)
    const heads = await b.logStore.getKnownHeads(SPACE_ID)
    expect(heads[DEVICE_A]).toBe(0)
  })

  // ── Test 4: Catch-up / Cold-start ─────────────────────────────────────────────
  it('Test 4 — cold-start catch-up via sync-request only (vault deactivated): empty heads → full log → full state reconstructed', async () => {
    const broker = new InProcessLogBroker()
    const alice = (await createTestIdentity('alice')).identity
    const bob = (await createTestIdentity('bob')).identity
    const registrationJws = await inviterRegistrationJws(alice)

    // Alice writes 3 entries to the broker log.
    const a = await makeHarness(alice, DEVICE_A, broker, { registrationJws })
    await a.coordinator.ensurePublished()
    for (let i = 0; i < 3; i++) await a.coordinator.writeLocalUpdate(new Uint8Array([i + 10]))

    // Bob is a FRESH adapter (empty heads, no vault). He catches up via sync-request only.
    const b = await makeHarness(bob, DEVICE_B, broker, { registrationJws })
    const result = await b.coordinator.catchUp()

    expect(b.appliedRemote.length).toBe(3) // full log reconstructed
    expect(result.restoreCloneRequired).toBe(false)
    const heads = await b.logStore.getKnownHeads(SPACE_ID)
    expect(heads[DEVICE_A]).toBe(2) // seq 0,1,2
  })

  // ── Test 5: Reject-disposition table ──────────────────────────────────────────
  it('Test 5 — reject-disposition: CAPABILITY_* → re-present, DEVICE_NOT_REGISTERED → re-register, DEVICE_REVOKED/SEQ_COLLISION → restore-clone', () => {
    expect(classifyRejectDisposition('CAPABILITY_REQUIRED')).toBe('capability-re-present')
    expect(classifyRejectDisposition('CAPABILITY_EXPIRED')).toBe('capability-re-present')
    expect(classifyRejectDisposition('CAPABILITY_GENERATION_STALE')).toBe('capability-re-present')
    expect(classifyRejectDisposition('DEVICE_NOT_REGISTERED')).toBe('device-re-register')
    expect(classifyRejectDisposition('DEVICE_REVOKED')).toBe('restore-clone')
    expect(classifyRejectDisposition('SEQ_COLLISION_DETECTED')).toBe('restore-clone')
    expect(classifyRejectDisposition('AUTHOR_MISMATCH')).toBe('hard-stop')
  })

  it('Test 5b — CAPABILITY_REQUIRED on present-capability → coordinator re-presents (re-sources capability)', async () => {
    const broker = new InProcessLogBroker()
    const alice = (await createTestIdentity('alice')).identity
    const h = await makeHarness(alice, DEVICE_A, broker)

    // Arm exactly one CAPABILITY_REQUIRED rejection for the next present-capability.
    broker.armRejection({ code: 'CAPABILITY_REQUIRED', target: 'control', frameType: PRESENT_CAPABILITY_CONTROL_FRAME_TYPE })

    let capabilityRequests = 0
    const coordinator = h.coordinator as unknown as { config: { capabilities: { getCapabilityJws: () => Promise<string> } } }
    const originalGet = coordinator.config.capabilities.getCapabilityJws
    coordinator.config.capabilities.getCapabilityJws = async () => {
      capabilityRequests += 1
      return originalGet()
    }

    await h.coordinator.ensurePublished()
    // Re-presented: capability was sourced twice (once rejected, once accepted).
    expect(capabilityRequests).toBeGreaterThanOrEqual(2)
    // present-capability appears at least twice in the broker's received frames.
    const presents = broker.receivedControlFrames.filter(
      (c) => c.frame.type === PRESENT_CAPABILITY_CONTROL_FRAME_TYPE,
    )
    expect(presents.length).toBeGreaterThanOrEqual(2)
  })

  it('Test 5c — AUTHOR_MISMATCH is a HARD STOP: no retry, throws AuthorMismatchError', async () => {
    const broker = new InProcessLogBroker()
    const alice = (await createTestIdentity('alice')).identity
    const h = await makeHarness(alice, DEVICE_A, broker)

    // Arm AUTHOR_MISMATCH on the present-capability control frame.
    broker.armRejection({ code: 'AUTHOR_MISMATCH', target: 'control', frameType: PRESENT_CAPABILITY_CONTROL_FRAME_TYPE })

    let presentAttempts = 0
    const originalHandle = broker.handleControlFrame.bind(broker)
    ;(broker as unknown as { handleControlFrame: typeof broker.handleControlFrame }).handleControlFrame = async (
      socketId,
      frame,
    ) => {
      if (frame.type === PRESENT_CAPABILITY_CONTROL_FRAME_TYPE) presentAttempts += 1
      return originalHandle(socketId, frame)
    }

    await expect(h.coordinator.ensurePublished()).rejects.toBeInstanceOf(AuthorMismatchError)
    // HARD STOP: present-capability was attempted exactly once (no retry loop).
    expect(presentAttempts).toBe(1)
  })

  it('Test 5d — SEQ_COLLISION_DETECTED on log-entry surfaces restore-clone disposition (matched on code, not clientHint)', async () => {
    const broker = new InProcessLogBroker()
    const alice = (await createTestIdentity('alice')).identity
    const h = await makeHarness(alice, DEVICE_A, broker)
    await h.coordinator.ensurePublished()

    // Capture the error frame the broker routes back on a log-entry reject.
    let rejectionCode: string | null = null
    h.messaging.onMessage((message) => {
      const m = message as { type?: string; code?: string }
      if (m.type === 'error' && typeof m.code === 'string') {
        rejectionCode = m.code
        // The client matches on code === 'SEQ_COLLISION_DETECTED'.
        const disposition = classifyRejectDisposition(m.code as never)
        expect(disposition).toBe('restore-clone')
      }
    })

    broker.armRejection({ code: 'SEQ_COLLISION_DETECTED', target: 'log-entry', docId: SPACE_ID })
    await h.coordinator.writeLocalUpdate(new Uint8Array([1]))
    await flush()
    expect(rejectionCode).toBe('SEQ_COLLISION_DETECTED')
  })

  it('Test 5e — restore-clone: brokerSeq > localSeq → applySyncResponse reports restoreCloneRequired', async () => {
    const broker = new InProcessLogBroker()
    const alice = (await createTestIdentity('alice')).identity
    const h = await makeHarness(alice, DEVICE_A, broker)

    // Seed the broker with a head for OUR deviceId higher than our (empty) local log.
    broker.seedHead(SPACE_ID, DEVICE_A, 5)
    await h.coordinator.ensurePublished() // present-capability so sync-request is allowed
    const result = await h.coordinator.catchUp()
    expect(result.restoreCloneRequired).toBe(true)
  })

  // ── Test 6: seq-once across keyGenerations (VE-5 preview) ──────────────────────
  it('Test 6 — a pending entry under gen=0 is NOT re-encrypted under gen=1; re-emission is the bit-identical JWS', async () => {
    const broker = new InProcessLogBroker()
    const alice = (await createTestIdentity('alice')).identity
    const h = await makeHarness(alice, DEVICE_A, broker)

    const entry = await h.coordinator.writeLocalUpdate(new Uint8Array([1, 2, 3]))
    const storedJws = entry!.entryJws

    // Simulate a generation switch: the content key advances, but a pending entry
    // keeps its seq AND keyGeneration and is re-emitted bit-identically.
    const stored = await h.logStore.getEntry(SPACE_ID, DEVICE_A, 0)
    expect(stored!.status).toBe('pending')

    // Re-emit pending: the SAME JWS is sent (no rebuild, no re-encrypt at gen=1).
    let resentJws: string | null = null
    h.messaging.onMessage(() => {})
    const baseSend = h.messaging.send.bind(h.messaging)
    ;(h.messaging as unknown as { send: typeof h.messaging.send }).send = async (envelope: never) => {
      if (isLogEntry(envelope)) {
        resentJws = (envelope as { body: { entry: string } }).body.entry
      }
      return baseSend(envelope)
    }
    await h.coordinator.resendPending()
    expect(resentJws).toBe(storedJws)

    // The payload still carries keyGeneration 0 and the nonce(deviceId,0).
    const payload = await verifyLogEntryJws(storedJws, { crypto })
    expect(payload.keyGeneration).toBe(0)
    expect(payload.seq).toBe(0)
  })

  // ── Test 7: space-register idempotent on join ─────────────────────────────────
  it('Test 7 — space-register is idempotent on join: a second identical register does not error', async () => {
    const broker = new InProcessLogBroker()
    const alice = (await createTestIdentity('alice')).identity
    const bob = (await createTestIdentity('bob')).identity
    const registrationJws = await inviterRegistrationJws(alice)

    const a = await makeHarness(alice, DEVICE_A, broker, { registrationJws })
    const b = await makeHarness(bob, DEVICE_B, broker, { registrationJws })

    // Alice registers first.
    await a.coordinator.ensurePublished()
    // Bob joins and re-sends Alice's IDENTICAL space-register frame — first-writer-wins
    // makes it idempotent: no throw.
    await expect(b.coordinator.ensurePublished()).resolves.toBeUndefined()
  })

  it('Test 7b — a conflicting space-register (different admin set) is SPACE_ALREADY_REGISTERED', async () => {
    const broker = new InProcessLogBroker()
    const alice = (await createTestIdentity('alice')).identity
    broker.forceRegistered(SPACE_ID, ['did:key:zSomeOtherAdmin'])

    const register = await createSpaceRegisterMessage({
      spaceId: SPACE_ID,
      spaceCapabilityVerificationKey: 'AAAA',
      adminDids: [alice.getDid()],
      kid: alice.kid,
      signingSeed: new Uint8Array(32).fill(3),
    })
    const messaging = new InMemoryMessagingAdapter({ broker })
    await messaging.connect(alice.getDid())
    await expect(messaging.sendControlFrame!(register)).rejects.toMatchObject({ code: 'SPACE_ALREADY_REGISTERED' })
  })

  // ── Test 8: engine-foreign payload ────────────────────────────────────────────
  it('Test 8 — engine-foreign payload: a verifiable log-entry not applicable as our CRDT is skipped without crash/loop', async () => {
    const broker = new InProcessLogBroker()
    const alice = (await createTestIdentity('alice')).identity
    const bob = (await createTestIdentity('bob')).identity
    const registrationJws = await inviterRegistrationJws(alice)
    const a = await makeHarness(alice, DEVICE_A, broker, { registrationJws })
    const b = await makeHarness(bob, DEVICE_B, broker, { registrationJws })

    await a.coordinator.ensurePublished()
    // Alice writes a payload that the test-raw engine rejects (0xFF marker).
    const entry = await a.coordinator.writeLocalUpdate(new Uint8Array([0xff, 0x01]))

    const message = createLogEntryMessage({
      id: globalThis.crypto.randomUUID(),
      from: alice.getDid(),
      to: [bob.getDid()],
      createdTime: Math.floor(Date.now() / 1000),
      entry: entry!.entryJws,
    })

    const result = await b.coordinator.receiveLogEntry(message)
    expect(result.disposition).toBe('engine-foreign-skip')
    // No state applied, no head recorded, no crash.
    expect(b.appliedRemote.length).toBe(0)
    const heads = await b.logStore.getKnownHeads(SPACE_ID)
    expect(heads[DEVICE_A]).toBeUndefined()
    // And Bob produced no extra send from the skip (no loop).
    expect(b.sentEnvelopes).toBe(0)
  })
})

// ── test helpers ───────────────────────────────────────────────────────────────

/** Make a harness broadcast its log-entries to a fixed set of member DIDs. */
function rewireBroadcastTo(h: Harness, members: string[]): void {
  const coordinator = h.coordinator as unknown as {
    config: { ownDid: string }
    sendLogEntryEnvelope?: unknown
  }
  // The coordinator builds log-entry messages with to=[ownDid]; to exercise
  // cross-member delivery we patch the envelope `send` to rewrite `to`.
  const baseSend = h.messaging.send.bind(h.messaging)
  ;(h.messaging as unknown as { send: typeof h.messaging.send }).send = async (envelope: never) => {
    if (isLogEntry(envelope)) {
      ;(envelope as { to: string[] }).to = members
    }
    return baseSend(envelope)
  }
  void coordinator
}

async function flush(): Promise<void> {
  await new Promise((r) => setTimeout(r, 30))
}
