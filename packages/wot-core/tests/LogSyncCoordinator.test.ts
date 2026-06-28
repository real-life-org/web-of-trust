import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { InMemoryMessagingAdapter, InProcessLogBroker } from '../src/adapters/messaging'
import { InMemoryDocLogStore } from '../src/adapters/storage/InMemoryDocLogStore'
import { WebCryptoProtocolCryptoAdapter } from '../src/adapters/protocol-crypto'
import { createTestIdentity } from './helpers/identity-session'
import type { PublicIdentitySession } from '../src/application/identity'
import {
  LogSyncCoordinator,
  AuthorMismatchError,
  PersonalDocOwnerMismatchError,
  LocalAppendFailedError,
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

async function makeCapability(audience: string, generation = 0): Promise<string> {
  return createSpaceCapabilityJws({
    payload: {
      type: 'capability',
      spaceId: SPACE_ID,
      audience,
      permissions: ['read', 'write'],
      generation,
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
    // Slice B v2: isForeignPayload removed with the (a)-model — the 0xFF marker now
    // surfaces purely as an applyRemoteUpdate throw → engine-foreign-skip.
  }
}

/**
 * Slice SR / VE-C2: a mutable multi-generation key state for the legitimate-lagger
 * tests. `current` is the local current generation; `keys` maps generation → key
 * bytes (a generation the lagger has not yet caught up to is simply absent). A test
 * advances the generation by setting `current` and adding the new key — modelling a
 * key-rotation arriving in the inbox and being imported into key management.
 */
interface KeyState {
  current: number
  keys: Map<number, Uint8Array>
}

function makeKeyState(): KeyState {
  return { current: 0, keys: new Map([[0, CONTENT_KEY]]) }
}

async function makeHarness(
  identity: PublicIdentitySession,
  deviceId: string,
  broker: InProcessLogBroker,
  opts?: {
    adminDids?: string[]
    sendSpaceRegister?: boolean
    registrationJws?: string
    /** VE-C2: a shared mutable key state so the test can advance the generation. */
    keyState?: KeyState
    /** VE-C2: a bounded awaitKeyGenerationAdvance hook (defaults: immediate check). */
    awaitKeyGenerationAdvance?: (rejectedGeneration: number) => Promise<boolean>
    /** Security-error surface (SeqCollision / DeviceRevoked / PersonalDocOwnerMismatch). */
    onSecurityError?: (err: Error) => void
  },
): Promise<Harness> {
  const messaging = new InMemoryMessagingAdapter({ broker })
  await messaging.connect(identity.getDid())

  const logStore = new InMemoryDocLogStore()
  await logStore.init()

  const appliedRemote: Uint8Array[] = []
  const harness: Partial<Harness> = {
    identity,
    messaging,
    logStore,
    appliedRemote,
    sentEnvelopes: 0,
  }

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
      // Mirror the real adapter: present the capability for the CURRENT generation.
      // The steady-state tests keep generation 0; the VE-C2 lagger tests advance it.
      getCapabilityJws: () => makeCapability(identity.getDid(), opts?.keyState?.current ?? 0),
    },
    hooks: makeHooks(appliedRemote),
    signLogEntry: (input) => identity.signEd25519(input),
    getContentKey: async () => {
      const ks = opts?.keyState
      if (!ks) return { key: CONTENT_KEY, generation: 0 }
      const key = ks.keys.get(ks.current)
      return key ? { key, generation: ks.current } : null
    },
    // Per-generation key lookup. With a keyState, a generation the lagger has not yet
    // imported is absent (null) — exactly the catch-up dependency the VE-C2 re-emit
    // must respect. Without a keyState, the steady-state harness keeps gen-0 only.
    getContentKeyByGeneration: async (generation) => {
      const ks = opts?.keyState
      if (!ks) return generation <= 0 ? CONTENT_KEY : null
      return ks.keys.get(generation) ?? null
    },
    getAvailableKeyGenerations: async () => {
      const ks = opts?.keyState
      if (!ks) return [0]
      return [...ks.keys.keys()].sort((a, b) => a - b)
    },
    awaitKeyGenerationAdvance: opts?.awaitKeyGenerationAdvance,
    onSecurityError: opts?.onSecurityError,
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

  // ── Durable Wiring / E1: a non-transient local-append failure is wrapped + propagated ──
  it('E1 — a non-transient appendLocalEntry failure rejects writeLocalUpdate with LocalAppendFailedError (the CRDT write is NOT silently lost)', async () => {
    const broker = new InProcessLogBroker()
    const alice = (await createTestIdentity('alice')).identity
    const h = await makeHarness(alice, DEVICE_A, broker)

    // Simulate a non-transient durable failure (exhausted seq retries / IDB quota /
    // crypto build failure) — anything that escapes appendLocalEntry is non-transient.
    const cause = new Error('IDB quota exceeded')
    h.logStore.appendLocalEntry = async () => {
      throw cause
    }

    // ensurePublished still succeeds (it does not append); the append is what fails.
    let thrown: unknown
    await h.coordinator.writeLocalUpdate(new Uint8Array([1, 2, 3])).catch((e) => {
      thrown = e
    })
    expect(thrown).toBeInstanceOf(LocalAppendFailedError)
    expect((thrown as LocalAppendFailedError).reason).toBe(cause)
    expect((thrown as LocalAppendFailedError).deviceId).toBe(DEVICE_A)

    // The write did NOT advance durable state: nothing was persisted under seq=0, so
    // the failure surfaces instead of leaving "the update applied but never logged" drift.
    expect(await h.logStore.getEntry(SPACE_ID, DEVICE_A, 0)).toBeNull()
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
    // A2 Teil B (TOFU): owner-mismatch is a hard stop, not retry/unknown (silently ignored).
    expect(classifyRejectDisposition('PERSONAL_DOC_OWNER_MISMATCH')).toBe('hard-stop')
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

  // ── A2 Teil B (TOFU owner-binding): PERSONAL_DOC_OWNER_MISMATCH is a HARD STOP ─────
  it('Test 5f — PERSONAL_DOC_OWNER_MISMATCH on a routed write-path reject is NOT silently ignored (hard stop, surfaced)', async () => {
    const broker = new InProcessLogBroker()
    const alice = (await createTestIdentity('alice')).identity
    const securityErrors: Error[] = []
    const h = await makeHarness(alice, DEVICE_A, broker, { onSecurityError: (err) => securityErrors.push(err) })

    // Feed the routed write-path reject code directly to the coordinator's reject handler
    // (the API the adapter wiring calls on a `{ type:'error', thid, code }` frame). A code
    // absent from the closed catalog would fall to 'unknown' and be silently dropped; this
    // asserts the owner-mismatch is instead classified as a hard stop and surfaced.
    await expect(
      h.coordinator.handleWriteReject('PERSONAL_DOC_OWNER_MISMATCH', DEVICE_A, 0),
    ).rejects.toBeInstanceOf(PersonalDocOwnerMismatchError)
    // Surfaced via onSecurityError (the throw alone is only console-logged by the dispatch).
    expect(securityErrors).toHaveLength(1)
    expect(securityErrors[0]).toBeInstanceOf(PersonalDocOwnerMismatchError)
    // NOT an AUTHOR_MISMATCH masquerade — the typed error must be honest.
    expect(securityErrors[0]).not.toBeInstanceOf(AuthorMismatchError)
  })

  it('Test 5g — PERSONAL_DOC_OWNER_MISMATCH on present-capability → hard stop, no retry, throws PersonalDocOwnerMismatchError', async () => {
    const broker = new InProcessLogBroker()
    const alice = (await createTestIdentity('alice')).identity
    const securityErrors: Error[] = []
    const h = await makeHarness(alice, DEVICE_A, broker, { onSecurityError: (err) => securityErrors.push(err) })

    broker.armRejection({ code: 'PERSONAL_DOC_OWNER_MISMATCH', target: 'control', frameType: PRESENT_CAPABILITY_CONTROL_FRAME_TYPE })

    let presentAttempts = 0
    const originalHandle = broker.handleControlFrame.bind(broker)
    ;(broker as unknown as { handleControlFrame: typeof broker.handleControlFrame }).handleControlFrame = async (
      socketId,
      frame,
    ) => {
      if (frame.type === PRESENT_CAPABILITY_CONTROL_FRAME_TYPE) presentAttempts += 1
      return originalHandle(socketId, frame)
    }

    await expect(h.coordinator.ensurePublished()).rejects.toBeInstanceOf(PersonalDocOwnerMismatchError)
    // HARD STOP: present-capability was attempted exactly once (no retry loop).
    expect(presentAttempts).toBe(1)
    expect(securityErrors).toHaveLength(1)
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

    // Suppress the delivery receipt for the FIRST write so the entry stays
    // 'pending' (CONCERN-1 markAcked-on-receipt would otherwise ack it). This
    // isolates the property under test: re-emission of a STILL-PENDING entry uses
    // the bit-identical stored JWS (no rebuild / no re-encrypt across generations).
    let suppressReceipt = true
    h.messaging.onMessage(() => {})
    const baseSend = h.messaging.send.bind(h.messaging)
    let resentJws: string | null = null
    ;(h.messaging as unknown as { send: typeof h.messaging.send }).send = async (envelope: never) => {
      if (isLogEntry(envelope)) {
        resentJws = (envelope as { body: { entry: string } }).body.entry
        const receipt = await baseSend(envelope)
        return suppressReceipt ? (undefined as never) : receipt
      }
      return baseSend(envelope)
    }

    const entry = await h.coordinator.writeLocalUpdate(new Uint8Array([1, 2, 3]))
    const storedJws = entry!.entryJws

    // Pending (receipt suppressed): keeps its seq AND keyGeneration for re-emission.
    const stored = await h.logStore.getEntry(SPACE_ID, DEVICE_A, 0)
    expect(stored!.status).toBe('pending')

    // Re-emit pending: the SAME JWS is sent (no rebuild, no re-encrypt at gen=1).
    resentJws = null
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

// ── VE-C2: KEY_GENERATION_STALE re-emit (the LEGITIME LAGGER) ────────────────────
//
// A still-active member missed a Space-Rotation and authored a log-entry under the
// OLD content key. The broker rejects that OLD-gen write KEY_GENERATION_STALE
// (Sync 003 §Broker-Ingest-Generations-Gate). VE-C2 catches up the missed rotation
// and re-emits the SAME CRDT update under a NEW seq + the NEW keyGeneration — NEVER
// the same seq (same seq + new key = AES-GCM nonce reuse; the Slice-A blocker).
describe('LogSyncCoordinator — VE-C2: KEY_GENERATION_STALE re-emit (legitimate lagger)', () => {
  it('Test C2-1 — classifyRejectDisposition(KEY_GENERATION_STALE) → key-generation-catch-up-and-reemit', () => {
    expect(classifyRejectDisposition('KEY_GENERATION_STALE')).toBe('key-generation-catch-up-and-reemit')
  })

  it('Test C2-2 — live lagger: stale write → catch up rotation → re-emit SAME update under NEW seq + new gen; old seq superseded (acked), no double-apply', async () => {
    const broker = new InProcessLogBroker()
    const alice = (await createTestIdentity('alice')).identity

    // Two generations of the same shared content key. gen-0 = the lagger's stale key,
    // gen-1 = the rotated key (DISTINCT bytes so we can prove the re-emit re-encrypts).
    const KEY_GEN0 = new Uint8Array(32).fill(7)
    const KEY_GEN1 = new Uint8Array(32).fill(11)
    const keyState: KeyState = { current: 0, keys: new Map([[0, KEY_GEN0]]) }

    const h = await makeHarness(alice, DEVICE_A, broker, {
      keyState,
      // Catch-up: the rotation is applied (gen advances to 1) the moment the re-emit
      // path asks to advance — models a key-rotation already importable in the inbox.
      awaitKeyGenerationAdvance: async (rejectedGen) => {
        if (keyState.current <= rejectedGen) {
          keyState.current = rejectedGen + 1
          keyState.keys.set(keyState.current, KEY_GEN1)
        }
        return keyState.current > rejectedGen
      },
    })
    await h.coordinator.ensurePublished()

    // Arm a ONE-SHOT KEY_GENERATION_STALE for the lagger's first (gen-0) write.
    broker.armRejection({ code: 'KEY_GENERATION_STALE', target: 'log-entry', docId: SPACE_ID })

    const update = new Uint8Array([5, 6, 7, 8])
    const stale = await h.coordinator.writeLocalUpdate(update)
    expect(stale!.seq).toBe(0)
    await flush()

    // (a) The old (gen-0, seq=0) entry is SUPERSEDED — markAcked'd so resendPending
    // never re-sends it (no KEY_GENERATION_STALE churn loop).
    const oldEntry = await h.logStore.getEntry(SPACE_ID, DEVICE_A, 0)
    expect(oldEntry!.status).toBe('acked')
    const oldPayload = await verifyLogEntryJws(oldEntry!.entryJws, { crypto })
    expect(oldPayload.keyGeneration).toBe(0)

    // (b) A re-emit was written under a NEW seq (1), NOT the same seq.
    const reemit = await h.logStore.getEntry(SPACE_ID, DEVICE_A, 1)
    expect(reemit).not.toBeNull()
    const reemitPayload = await verifyLogEntryJws(reemit!.entryJws, { crypto })
    expect(reemitPayload.seq).toBe(1)
    expect(reemitPayload.keyGeneration).toBe(1) // re-emitted under the NEW generation

    // (c) The re-emit carries the SAME CRDT update (decrypts under the NEW key to the
    // identical bytes) — same update, new seq, new gen.
    const reemitBlob = decodeBase64Url(reemitPayload.data)
    const reemitNonce = await deriveLogPayloadNonce(crypto, DEVICE_A, 1)
    expect(Array.from(reemitBlob.slice(0, 12))).toEqual(Array.from(reemitNonce))
    const reemitPlain = await decryptLogPayload({ crypto, spaceContentKey: KEY_GEN1, blob: reemitBlob })
    expect(Array.from(reemitPlain)).toEqual(Array.from(update))

    // (d) The broker durably holds exactly the re-emit at (DEVICE_A, seq=1) — the
    // gen-0 entry was gated out (rejected, never stored). No double-store.
    const brokerDoc = (broker as unknown as { docs: Map<string, { entries: Map<string, unknown> }> }).docs.get(SPACE_ID)!
    expect(brokerDoc.entries.has(`${DEVICE_A}:0`)).toBe(false)
    expect(brokerDoc.entries.has(`${DEVICE_A}:1`)).toBe(true)
  })

  it('Test C2-3 — re-emit NEVER re-uses the same seq (nonce-safety): new seq strictly greater, old seq not re-sent', async () => {
    const broker = new InProcessLogBroker()
    const alice = (await createTestIdentity('alice')).identity
    const KEY_GEN0 = new Uint8Array(32).fill(7)
    const KEY_GEN1 = new Uint8Array(32).fill(11)
    const keyState: KeyState = { current: 0, keys: new Map([[0, KEY_GEN0]]) }
    const h = await makeHarness(alice, DEVICE_A, broker, {
      keyState,
      awaitKeyGenerationAdvance: async (rejectedGen) => {
        keyState.current = rejectedGen + 1
        keyState.keys.set(keyState.current, KEY_GEN1)
        return true
      },
    })
    await h.coordinator.ensurePublished()

    // Track every seq that hits the wire (log-entry payloads sent).
    const sentSeqs: number[] = []
    const baseSend = h.messaging.send.bind(h.messaging)
    ;(h.messaging as unknown as { send: typeof h.messaging.send }).send = async (envelope: never) => {
      if (isLogEntry(envelope)) {
        const p = await verifyLogEntryJws((envelope as { body: { entry: string } }).body.entry, { crypto })
        sentSeqs.push(p.seq)
      }
      return baseSend(envelope)
    }

    broker.armRejection({ code: 'KEY_GENERATION_STALE', target: 'log-entry', docId: SPACE_ID })
    await h.coordinator.writeLocalUpdate(new Uint8Array([1]))
    await flush()

    // The stale send was seq=0; the re-emit was seq=1. Seq 0 was NEVER re-sent under
    // a new key (that would be a nonce reuse). seqs are strictly increasing + unique.
    expect(sentSeqs).toContain(0)
    expect(sentSeqs).toContain(1)
    expect(sentSeqs.filter((s) => s === 0).length).toBe(1) // gen-0 seq=0 sent exactly once
    expect(new Set(sentSeqs).size).toBe(sentSeqs.length) // no seq repeated

    // A subsequent reconnect resendPending does NOT re-send the superseded gen-0 entry.
    sentSeqs.length = 0
    await h.coordinator.resendPending()
    expect(sentSeqs).not.toContain(0)
  })

  it('Test C2-4 — crash-recovery: in-memory update gone → decrypt persisted alt-gen JWS with historical key → re-emit under new gen', async () => {
    const broker = new InProcessLogBroker()
    const alice = (await createTestIdentity('alice')).identity
    const KEY_GEN0 = new Uint8Array(32).fill(7)
    const KEY_GEN1 = new Uint8Array(32).fill(11)
    const keyState: KeyState = { current: 0, keys: new Map([[0, KEY_GEN0]]) }
    const h = await makeHarness(alice, DEVICE_A, broker, {
      keyState,
      awaitKeyGenerationAdvance: async (rejectedGen) => {
        keyState.current = rejectedGen + 1
        keyState.keys.set(keyState.current, KEY_GEN1)
        return true
      },
    })
    await h.coordinator.ensurePublished()

    const update = new Uint8Array([21, 22, 23])
    // Write a gen-0 entry that the broker ACCEPTS (no arming) so it persists as a real
    // pending/acked entry; then simulate a crash by clearing the in-memory retention.
    const persisted = await h.coordinator.writeLocalUpdate(update)
    expect(persisted!.seq).toBe(0)

    // Simulate crash: wipe the coordinator's in-memory inFlightWrites (the retained
    // plaintext is gone — only the durable alt-gen JWS survives).
    ;(h.coordinator as unknown as { inFlightWrites: Map<string, unknown> }).inFlightWrites.clear()

    // Now the space rotated past gen-0; a reconnect resendPending re-sends the gen-0
    // JWS → broker gate rejects KEY_GENERATION_STALE → crash-recovery re-emit path.
    // Advance the broker's durable generation so the gen-0 re-send is gated out.
    ;(broker as unknown as { docs: Map<string, { generation: number }> }).docs.get(SPACE_ID)!.generation = 1
    // Re-mark the entry pending so resendPending actually re-sends it (a real crash
    // would still have it pending; the accept above acked it via the receipt path).
    ;(h.logStore as unknown as {
      entries: Map<string, { status: string }>
    }).entries.forEach((e) => {
      if ((e as { seq?: number }).seq === 0) e.status = 'pending'
    })

    await h.coordinator.resendPending()
    await flush()

    // Crash-recovery re-emitted under a NEW seq + the new generation, decrypting the
    // historical gen-0 JWS with the historical key — no plaintext-at-rest needed.
    const reemit = await h.logStore.getEntry(SPACE_ID, DEVICE_A, 1)
    expect(reemit).not.toBeNull()
    const reemitPayload = await verifyLogEntryJws(reemit!.entryJws, { crypto })
    expect(reemitPayload.seq).toBe(1)
    expect(reemitPayload.keyGeneration).toBe(1)
    const reemitPlain = await decryptLogPayload({
      crypto,
      spaceContentKey: KEY_GEN1,
      blob: decodeBase64Url(reemitPayload.data),
    })
    expect(Array.from(reemitPlain)).toEqual(Array.from(update))
  })

  it('Test C2-5 — parks (no re-emit) when the rotation has NOT arrived: stale entry stays pending, no new seq, no busy loop', async () => {
    const broker = new InProcessLogBroker()
    const alice = (await createTestIdentity('alice')).identity
    const KEY_GEN0 = new Uint8Array(32).fill(7)
    const keyState: KeyState = { current: 0, keys: new Map([[0, KEY_GEN0]]) }
    let advanceCalls = 0
    const h = await makeHarness(alice, DEVICE_A, broker, {
      keyState,
      // The rotation has NOT arrived: never advance, always report "not yet".
      awaitKeyGenerationAdvance: async () => {
        advanceCalls += 1
        return false
      },
    })
    await h.coordinator.ensurePublished()

    broker.armRejection({ code: 'KEY_GENERATION_STALE', target: 'log-entry', docId: SPACE_ID })
    await h.coordinator.writeLocalUpdate(new Uint8Array([1]))
    await flush()

    // Parked: the stale entry stays pending (NOT acked), no re-emit at seq=1.
    const stale = await h.logStore.getEntry(SPACE_ID, DEVICE_A, 0)
    expect(stale!.status).toBe('pending')
    expect(await h.logStore.getEntry(SPACE_ID, DEVICE_A, 1)).toBeNull()
    // Bounded: awaitKeyGenerationAdvance was consulted exactly once (no busy spin).
    expect(advanceCalls).toBe(1)
    // And the re-emit is PARKED (not lost) — drained later by replayPendingReemits.
    expect(h.coordinator.pendingReemitCount()).toBe(1)
  })

  it('Test C2-6 — park then drain: a parked re-emit fires via replayPendingReemits once the rotation lands', async () => {
    const broker = new InProcessLogBroker()
    const alice = (await createTestIdentity('alice')).identity
    const KEY_GEN0 = new Uint8Array(32).fill(7)
    const KEY_GEN1 = new Uint8Array(32).fill(11)
    const keyState: KeyState = { current: 0, keys: new Map([[0, KEY_GEN0]]) }

    // The rotation has NOT arrived yet: awaitKeyGenerationAdvance reports the current
    // (un-advanced) state. The test "lands" the rotation later, then calls the drain.
    const h = await makeHarness(alice, DEVICE_A, broker, {
      keyState,
      awaitKeyGenerationAdvance: async (rejectedGen) => keyState.current > rejectedGen,
    })
    await h.coordinator.ensurePublished()

    const update = new Uint8Array([31, 32, 33])
    broker.armRejection({ code: 'KEY_GENERATION_STALE', target: 'log-entry', docId: SPACE_ID })
    await h.coordinator.writeLocalUpdate(update)
    await flush()

    // Parked (rotation not yet imported): no re-emit, stale entry still pending.
    expect(h.coordinator.pendingReemitCount()).toBe(1)
    expect(await h.logStore.getEntry(SPACE_ID, DEVICE_A, 1)).toBeNull()
    expect((await h.logStore.getEntry(SPACE_ID, DEVICE_A, 0))!.status).toBe('pending')

    // The missed key-rotation now lands (imported into key management).
    keyState.current = 1
    keyState.keys.set(1, KEY_GEN1)

    // Drain (the adapter calls this on a key-rotation import, next to replayBlockedByKey).
    const fired = await h.coordinator.replayPendingReemits()
    await flush()

    expect(fired).toBe(1)
    expect(h.coordinator.pendingReemitCount()).toBe(0)
    // The re-emit landed at a NEW seq under the new generation; old seq superseded.
    const reemit = await h.logStore.getEntry(SPACE_ID, DEVICE_A, 1)
    expect(reemit).not.toBeNull()
    const reemitPayload = await verifyLogEntryJws(reemit!.entryJws, { crypto })
    expect(reemitPayload.seq).toBe(1)
    expect(reemitPayload.keyGeneration).toBe(1)
    const reemitPlain = await decryptLogPayload({
      crypto,
      spaceContentKey: KEY_GEN1,
      blob: decodeBase64Url(reemitPayload.data),
    })
    expect(Array.from(reemitPlain)).toEqual(Array.from(update))
    expect((await h.logStore.getEntry(SPACE_ID, DEVICE_A, 0))!.status).toBe('acked')
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
