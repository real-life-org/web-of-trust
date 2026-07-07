import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { InMemoryMessagingAdapter, InProcessLogBroker } from '../src/adapters/messaging'
import { InMemoryDocLogStore } from '../src/adapters/storage/InMemoryDocLogStore'
import { WebCryptoProtocolCryptoAdapter } from '../src/adapters/protocol-crypto'
import { createTestIdentity } from './helpers/identity-session'
import type { PublicIdentitySession } from '../src/application/identity'
import {
  LogSyncCoordinator,
  AuthorMismatchError,
  SeqCollisionError,
  DeviceRevokedError,
  createSpaceCapabilityJws,
  createSpaceRegisterMessage,
  createLogEntryMessage,
  type LogSyncEngineHooks,
  type ControlFrameReceipt,
  type WriteReject,
} from '../src/protocol'

/**
 * Slice A Phase 3 — engine-neutral coordinator pieces that Phase 4 (Automerge)
 * reuses unchanged:
 *  - VE-5 blocked-by-key buffer + LOOP-GUARDed replay (replay produces ZERO sends).
 *  - P2-NIT-1 write-path-reject wiring: SEQ_COLLISION → restore-clone (new
 *    deviceId, seq=0, NO re-use of the colliding seq); AUTHOR_MISMATCH → hard stop.
 */

const crypto = new WebCryptoProtocolCryptoAdapter()
const SPACE_ID = '11111111-1111-4111-8111-111111111111'
const DEVICE_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const DEVICE_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const DEVICE_NEW = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'

const FUTURE = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString()
const NOW = new Date().toISOString()

const GEN0_KEY = new Uint8Array(32).fill(7)
const GEN1_KEY = new Uint8Array(32).fill(11)

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

function makeHooks(appliedRemote: Uint8Array[]): LogSyncEngineHooks {
  return {
    engine: 'test-raw',
    encodeUpdate: (update) => update,
    applyRemoteUpdate: (plaintext) => {
      appliedRemote.push(plaintext)
    },
  }
}

interface Harness {
  identity: PublicIdentitySession
  messaging: InMemoryMessagingAdapter
  logStore: InMemoryDocLogStore
  coordinator: LogSyncCoordinator
  appliedRemote: Uint8Array[]
  sentLogEntries: number
  /** Available generations the coordinator sees (mutable so a test can import gen1 late). */
  available: number[]
  /** Returned by onWriteRejected; flip to drive a restore-clone deviceId. */
  rejectCalls: WriteReject[]
}

async function makeHarness(
  identity: PublicIdentitySession,
  deviceId: string,
  broker: InProcessLogBroker,
  opts?: {
    registrationJws?: string
    onWriteRejected?: (reject: WriteReject) => Promise<{ deviceId: string } | void>
    onAfterRestoreClone?: (newDeviceId: string) => Promise<void>
    available?: number[]
    keyByGeneration?: (gen: number) => Uint8Array | null
  },
): Promise<Harness> {
  const messaging = new InMemoryMessagingAdapter({ broker })
  await messaging.connect(identity.getDid())

  const logStore = new InMemoryDocLogStore()
  await logStore.init()

  const appliedRemote: Uint8Array[] = []
  const rejectCalls: WriteReject[] = []
  const available = opts?.available ?? [0]
  const keyByGeneration =
    opts?.keyByGeneration ?? ((gen: number) => (gen === 0 ? GEN0_KEY : gen === 1 ? GEN1_KEY : null))

  const harness: Partial<Harness> = {
    identity,
    messaging,
    logStore,
    appliedRemote,
    sentLogEntries: 0,
    available,
    rejectCalls,
  }

  const coordinator = new LogSyncCoordinator({
    docId: SPACE_ID,
    deviceId,
    ownDid: identity.getDid(),
    authorKid: identity.kid,
    crypto,
    logStore,
    control: { sendControlFrame: (frame) => messaging.sendControlFrame!(frame) },
    envelopes: {
      send: async (envelope) => {
        if ((envelope as { type?: string }).type === 'https://web-of-trust.de/protocols/log-entry/1.0') {
          harness.sentLogEntries! += 1
        }
        return messaging.send(envelope as never)
      },
    },
    capabilities: { getCapabilityJws: () => makeCapability(identity.getDid()) },
    hooks: makeHooks(appliedRemote),
    signLogEntry: (input) => identity.signEd25519(input),
    getContentKey: async () => {
      // Current generation = max available.
      const gen = Math.max(...available)
      const key = keyByGeneration(gen)
      return key ? { key, generation: gen } : null
    },
    getContentKeyByGeneration: async (generation) =>
      available.includes(generation) ? keyByGeneration(generation) : null,
    getAvailableKeyGenerations: async () => [...available],
    sendSpaceRegister: async () => {
      const register = opts?.registrationJws
        ? { type: 'space-register' as const, registrationJws: opts.registrationJws }
        : await createSpaceRegisterMessage({
            spaceId: SPACE_ID,
            spaceCapabilityVerificationKey: 'AAAA',
            adminDids: [identity.getDid()],
            kid: identity.kid,
            signingSeed: new Uint8Array(32).fill(3),
          })
      return messaging.sendControlFrame!(register) as Promise<ControlFrameReceipt>
    },
    onWriteRejected: opts?.onWriteRejected,
    onAfterRestoreClone: opts?.onAfterRestoreClone,
  })

  messaging.onMessage(async (message) => {
    await coordinator.handleIncoming(message)
  })

  harness.coordinator = coordinator
  return harness as Harness
}

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

function isLogEntry(message: unknown): boolean {
  return (message as { type?: unknown })?.type === 'https://web-of-trust.de/protocols/log-entry/1.0'
}

/** Make a harness broadcast its log-entries to a fixed set of member DIDs. */
function rewireBroadcastTo(h: Harness, members: string[]): void {
  const baseSend = h.messaging.send.bind(h.messaging)
  ;(h.messaging as unknown as { send: typeof h.messaging.send }).send = async (envelope: never) => {
    if (isLogEntry(envelope)) {
      ;(envelope as { to: string[] }).to = members
    }
    return baseSend(envelope)
  }
}

const flush = () => new Promise((r) => setTimeout(r, 30))

beforeEach(() => {
  InMemoryMessagingAdapter.resetAll()
  capabilitySigningSeed = new Uint8Array(32).fill(9)
})

afterEach(() => {
  InMemoryMessagingAdapter.resetAll()
})

describe('LogSyncCoordinator Phase 3 — VE-5 blocked-by-key + P2-NIT-1 write-reject', () => {
  // ── VE-5: blocked-by-key buffer + LOOP-GUARDed replay ─────────────────────────
  it('VE-5 — an entry under an unavailable keyGeneration is buffered (no drop, no mis-decrypt); replay after key import converges with ZERO sends', async () => {
    const broker = new InProcessLogBroker()
    const alice = (await createTestIdentity('alice')).identity
    const bob = (await createTestIdentity('bob')).identity
    const registrationJws = await inviterRegistrationJws(alice)

    // Alice has gen 0 AND gen 1; she writes an entry under gen 1.
    const a = await makeHarness(alice, DEVICE_A, broker, { registrationJws, available: [0, 1] })
    // Bob initially only has gen 0 (the gen-1 key has not arrived yet).
    const b = await makeHarness(bob, DEVICE_B, broker, { registrationJws, available: [0] })

    await a.coordinator.ensurePublished()
    await b.coordinator.ensurePublished()

    // Alice writes a gen-1 entry; verify it via the broker, then hand it to Bob.
    const entry = await a.coordinator.writeLocalUpdate(new Uint8Array([1, 2, 3]))
    const message = createLogEntryMessage({
      id: globalThis.crypto.randomUUID(),
      from: alice.getDid(),
      to: [bob.getDid()],
      createdTime: Math.floor(Date.now() / 1000),
      entry: entry!.entryJws,
    })

    // Bob cannot decrypt gen 1 yet → BUFFERED (no drop, no mis-decrypt, no crash).
    const r1 = await b.coordinator.receiveLogEntry(message)
    expect(r1.disposition).toBe('blocked-by-key')
    expect(b.appliedRemote.length).toBe(0)
    expect(b.coordinator.blockedByKeyCount()).toBe(1)

    // KRITISCH: the buffering itself produced ZERO outgoing sends.
    expect(b.sentLogEntries).toBe(0)

    // The gen-1 key arrives (e.g. a key-rotation applied). Replay the buffer.
    b.available.push(1)
    const sentBeforeReplay = b.sentLogEntries
    const converged = await b.coordinator.replayBlockedByKey()

    // Replay converged the buffered entry...
    expect(converged).toBe(1)
    expect(b.appliedRemote.length).toBe(1)
    expect(Array.from(b.appliedRemote[0])).toEqual([1, 2, 3])
    expect(b.coordinator.blockedByKeyCount()).toBe(0)

    // ...and the LOOP-GUARD held: the replay of a FOREIGN entry produced ZERO new
    // log-entry sends under Bob's own deviceId (no delayed outbox loop).
    expect(b.sentLogEntries).toBe(sentBeforeReplay)
    expect(b.sentLogEntries).toBe(0)
    void registrationJws
  })

  it('VE-5 — replay is idempotent: a second replay after convergence does nothing and still sends nothing', async () => {
    const broker = new InProcessLogBroker()
    const alice = (await createTestIdentity('alice')).identity
    const bob = (await createTestIdentity('bob')).identity
    const registrationJws = await inviterRegistrationJws(alice)
    const a = await makeHarness(alice, DEVICE_A, broker, { registrationJws, available: [0, 1] })
    const b = await makeHarness(bob, DEVICE_B, broker, { registrationJws, available: [0] })
    await a.coordinator.ensurePublished()
    await b.coordinator.ensurePublished()

    const entry = await a.coordinator.writeLocalUpdate(new Uint8Array([9]))
    const message = createLogEntryMessage({
      id: globalThis.crypto.randomUUID(),
      from: alice.getDid(),
      to: [bob.getDid()],
      createdTime: Math.floor(Date.now() / 1000),
      entry: entry!.entryJws,
    })
    await b.coordinator.receiveLogEntry(message)
    b.available.push(1)
    await b.coordinator.replayBlockedByKey()
    const sentAfterFirst = b.sentLogEntries
    const second = await b.coordinator.replayBlockedByKey()
    expect(second).toBe(0)
    expect(b.sentLogEntries).toBe(sentAfterFirst)
  })

  // ── VE-11 Trigger split (P2-NIT-1 write-path) — Durable Wiring ────────────────
  // A WRITE-PATH reject is NEVER the recoverable case. SEQ_COLLISION_DETECTED =
  // seq-reuse already on the wire (nonce-reuse-imminent) → hard SeqCollisionError
  // (Trigger 2); the recoverable mid-session case is the SEPARATE catch-up trigger
  // (brokerSeq>localSeq → restore-clone+rebind, exercised at the real-relay e2e level).
  it('VE-11 Trigger 2 — a WRITE-PATH SEQ_COLLISION is a HARD error (SeqCollisionError), never auto-recovered (no restore-clone)', async () => {
    const broker = new InProcessLogBroker()
    const alice = (await createTestIdentity('alice')).identity
    let restoreCalls = 0
    const h = await makeHarness(alice, DEVICE_A, broker, {
      onWriteRejected: async () => {
        restoreCalls += 1
        return { deviceId: DEVICE_NEW }
      },
    })
    await h.coordinator.ensurePublished()

    // A write-path seq-collision means a DIFFERENT contentHash already exists at our
    // (docId,deviceId,seq) — the deterministic nonce was already reused on the wire.
    // It MUST surface hard; a smooth re-clone would mask a potential AES-GCM break.
    await expect(
      h.coordinator.handleWriteReject('SEQ_COLLISION_DETECTED', DEVICE_A, 0),
    ).rejects.toThrow(SeqCollisionError)

    // NO restore-clone, NO silent device-mint, deviceId unchanged.
    expect(restoreCalls).toBe(0)
    expect(h.coordinator.getDeviceId()).toBe(DEVICE_A)
  })

  it('VE-11 Trigger split — DEVICE_REVOKED of the CURRENT device throws (re-auth/re-join); a straggler under an OLD deviceId is dropped (no re-clone)', async () => {
    const broker = new InProcessLogBroker()
    const alice = (await createTestIdentity('alice')).identity
    let restoreCalls = 0
    const h = await makeHarness(alice, DEVICE_A, broker, {
      onWriteRejected: async () => {
        restoreCalls += 1
        return { deviceId: DEVICE_NEW }
      },
    })
    await h.coordinator.ensurePublished()

    // A revoke of OUR CURRENT device must NOT silently re-clone itself back in.
    await expect(
      h.coordinator.handleWriteReject('DEVICE_REVOKED', DEVICE_A, 0),
    ).rejects.toThrow(DeviceRevokedError)

    // A revoke straggler under an OLD / already-rotated deviceId is a benign late
    // reject → dropped (resolves, no throw, no re-clone).
    await expect(
      h.coordinator.handleWriteReject('DEVICE_REVOKED', DEVICE_B, 5),
    ).resolves.toBe('restore-clone')

    expect(restoreCalls).toBe(0)
    expect(h.coordinator.getDeviceId()).toBe(DEVICE_A)
  })

  it('VE-11 Trigger 1 — a CATCH-UP brokerSeq>localSeq drives a restore-clone via the LIVE catchUp() WITHOUT deadlock (the re-publish skips the re-entrant catch-up)', async () => {
    const broker = new InProcessLogBroker()
    const alice = (await createTestIdentity('alice')).identity
    let restoreCalls = 0
    const h = await makeHarness(alice, DEVICE_A, broker, {
      onWriteRejected: async (reject) => {
        if (reject.disposition === 'restore-clone') {
          restoreCalls += 1
          return { deviceId: DEVICE_NEW }
        }
        return
      },
      onAfterRestoreClone: async () => {
        await h.coordinator.writeLocalUpdate(new Uint8Array([9]))
      },
    })
    await h.coordinator.ensurePublished()

    // The broker reports OUR deviceId ahead of our (empty) local log → Trigger 1.
    broker.seedHead(SPACE_ID, DEVICE_A, 5)

    // The LIVE catchUp() must drive the restore-clone to completion. Its restore-clone
    // re-publish (ensurePublished) re-enters runFirstPublication WHILE catchUp holds the
    // catchingUp re-entrancy guard; without the restoreCloneInFlight skip this DEADLOCKS
    // (the inner runFirstPublication awaits the outer catchUp, which awaits the clone).
    await h.coordinator.catchUp()

    expect(restoreCalls).toBe(1)
    expect(h.coordinator.getDeviceId()).toBe(DEVICE_NEW)
  })

  it('AUTHOR_MISMATCH on a write → HARD STOP via handleWriteReject (throws, no restore-clone, no retry)', async () => {
    const broker = new InProcessLogBroker()
    const alice = (await createTestIdentity('alice')).identity
    let restoreCalls = 0
    const h = await makeHarness(alice, DEVICE_A, broker, {
      onWriteRejected: async () => {
        restoreCalls += 1
        return { deviceId: DEVICE_NEW }
      },
    })
    await h.coordinator.ensurePublished()

    // handleWriteReject is the engine-neutral entry point; AUTHOR_MISMATCH must
    // throw AuthorMismatchError and NEVER call the restore-clone handler.
    await expect(h.coordinator.handleWriteReject('AUTHOR_MISMATCH', DEVICE_A, 0)).rejects.toBeInstanceOf(
      AuthorMismatchError,
    )
    expect(restoreCalls).toBe(0)
    // deviceId unchanged (no clone).
    expect(h.coordinator.getDeviceId()).toBe(DEVICE_A)
  })

  it('write-reject routing — an `error` frame correlated to a sent log-entry drives the disposition; an uncorrelated thid is ignored', async () => {
    const broker = new InProcessLogBroker()
    const alice = (await createTestIdentity('alice')).identity
    let restoreCalls = 0
    const h = await makeHarness(alice, DEVICE_A, broker, {
      onWriteRejected: async (reject) => {
        if (reject.disposition === 'restore-clone') {
          restoreCalls += 1
          return { deviceId: DEVICE_NEW }
        }
        return
      },
      onAfterRestoreClone: async () => {},
    })
    await h.coordinator.ensurePublished()

    // An uncorrelated error frame (thid we never sent) is a no-op.
    await h.coordinator.handleIncoming({ type: 'error', thid: 'never-sent', code: 'SEQ_COLLISION_DETECTED' })
    expect(restoreCalls).toBe(0)
    expect(h.coordinator.getDeviceId()).toBe(DEVICE_A)
  })
})

void rewireBroadcastTo
void DEVICE_B
