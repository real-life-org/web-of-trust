import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { InMemoryMessagingAdapter, InProcessLogBroker } from '../src/adapters/messaging'
import { InMemoryDocLogStore } from '../src/adapters/storage/InMemoryDocLogStore'
import { WebCryptoProtocolCryptoAdapter } from '../src/adapters/protocol-crypto'
import { createTestIdentity } from './helpers/identity-session'
import type { PublicIdentitySession } from '../src/application/identity'
import {
  LogSyncCoordinator,
  AuthorMismatchError,
  PersonalDocOwnerMismatchError,
  createSpaceCapabilityJws,
  createSpaceRegisterMessage,
  type LogSyncEngineHooks,
  type ControlFrameReceipt,
} from '../src/protocol'

/**
 * #236 (I-AUTH / I-ACK / I-TERM / I-LOCALFIRST): the LogSyncCoordinator is the
 * single retry authority for log entries. These tests pin the coordinator side:
 *  - a wrapper receipt (queued-in-outbox) is NOT a broker ack (TC-T3),
 *  - a transport failure keeps the entry pending and resendPending recovers (TC-R1a),
 *  - a sync-request send failure cleans its waiter + timer deterministically (TC-T6),
 *  - a correlated hard-stop reject terminally retires the entry (TC-T7).
 */
const crypto = new WebCryptoProtocolCryptoAdapter()
const SPACE_ID = '22222222-2222-4222-8222-222222222222'
const DEVICE_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'

const FUTURE = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString()
const NOW = new Date().toISOString()
const CONTENT_KEY = new Uint8Array(32).fill(7)
const capabilitySigningSeed = new Uint8Array(32).fill(9)

type SendMode = 'broker' | 'throw' | 'queued-receipt' | 'plain-accepted'

interface Harness {
  coordinator: LogSyncCoordinator
  logStore: InMemoryDocLogStore
  setSendMode: (mode: SendMode) => void
  envelopeSends: () => number
  securityErrors: Error[]
}

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

const hooks: LogSyncEngineHooks = {
  engine: 'test-raw',
  encodeUpdate: (update) => update,
  applyRemoteUpdate: () => {},
}

async function makeHarness(identity: PublicIdentitySession, broker: InProcessLogBroker): Promise<Harness> {
  const messaging = new InMemoryMessagingAdapter({ broker })
  await messaging.connect(identity.getDid())

  const logStore = new InMemoryDocLogStore()
  await logStore.init()

  let sendMode: SendMode = 'broker'
  let sends = 0
  const securityErrors: Error[] = []

  const coordinator = new LogSyncCoordinator({
    docId: SPACE_ID,
    deviceId: DEVICE_A,
    ownDid: identity.getDid(),
    authorKid: identity.kid,
    crypto,
    logStore,
    control: {
      sendControlFrame: (frame) => messaging.sendControlFrame!(frame),
    },
    envelopes: {
      send: async (envelope) => {
        sends += 1
        switch (sendMode) {
          case 'throw':
            throw new Error('transport down (#236 test)')
          case 'queued-receipt':
            // Exactly what the OutboxMessagingAdapter synthesizes for a queued send.
            return {
              messageId: (envelope as { id: string }).id,
              status: 'accepted',
              reason: 'queued-in-outbox',
              timestamp: new Date().toISOString(),
            }
          case 'plain-accepted':
            // A broker-issued accepted receipt (durably queued at the RELAY).
            return {
              messageId: (envelope as { id: string }).id,
              status: 'accepted',
              timestamp: new Date().toISOString(),
            }
          default:
            return messaging.send(envelope as never)
        }
      },
    },
    capabilities: {
      getCapabilityJws: () => makeCapability(identity.getDid()),
    },
    hooks,
    signLogEntry: (input) => identity.signEd25519(input),
    getContentKey: async () => ({ key: CONTENT_KEY, generation: 0 }),
    getContentKeyByGeneration: async (generation) => (generation <= 0 ? CONTENT_KEY : null),
    getAvailableKeyGenerations: async () => [0],
    onSecurityError: (err) => securityErrors.push(err),
    sendSpaceRegister: async () => {
      const register = await createSpaceRegisterMessage({
        spaceId: SPACE_ID,
        spaceCapabilityVerificationKey: 'AAAA',
        adminDids: [identity.getDid()],
        kid: identity.kid,
        signingSeed: new Uint8Array(32).fill(3),
      })
      return messaging.sendControlFrame!(register) as Promise<ControlFrameReceipt>
    },
  })

  return {
    coordinator,
    logStore,
    setSendMode: (mode) => { sendMode = mode },
    envelopeSends: () => sends,
    securityErrors,
  }
}

describe('#236 LogSyncCoordinator retry authority', () => {
  let identity: PublicIdentitySession
  let broker: InProcessLogBroker
  let h: Harness

  beforeEach(async () => {
    InMemoryMessagingAdapter.resetAll()
    broker = new InProcessLogBroker()
    identity = (await createTestIdentity('outbox-authority')).identity
    h = await makeHarness(identity, broker)
  })

  afterEach(async () => {
    vi.useRealTimers()
    InMemoryMessagingAdapter.resetAll()
    try { await identity.deleteStoredIdentity() } catch { /* ignore */ }
  })

  async function pendingSeqs(): Promise<number[]> {
    const pending = await h.logStore.getPending()
    return pending.filter((e) => e.docId === SPACE_ID && e.deviceId === DEVICE_A).map((e) => e.seq)
  }

  it('TC-T3: a queued-in-outbox wrapper receipt is NOT an ack — the entry stays pending', async () => {
    h.setSendMode('queued-receipt')
    const entry = await h.coordinator.writeLocalUpdate(new Uint8Array([1, 2, 3]))
    expect(entry).not.toBeNull()
    // The greenwash this guards against: pre-#236 the coordinator markAcked here and
    // resendPending never re-emitted — the capability-blind outbox became the only
    // (and silently dropping) delivery authority.
    expect(await pendingSeqs()).toEqual([entry!.seq])
  })

  it('TC-T3 (counter-probe): a broker-issued plain accepted receipt still acks', async () => {
    h.setSendMode('plain-accepted')
    const entry = await h.coordinator.writeLocalUpdate(new Uint8Array([1, 2, 3]))
    expect(entry).not.toBeNull()
    expect(await pendingSeqs()).toEqual([])
  })

  it('TC-R1a: a throwing transport does not fail the write; the entry stays pending and resendPending recovers it', async () => {
    h.setSendMode('throw')
    // I-LOCALFIRST: writeLocalUpdate must NOT throw for a transport failure.
    const entry = await h.coordinator.writeLocalUpdate(new Uint8Array([4, 5, 6]))
    expect(entry).not.toBeNull()
    expect(await pendingSeqs()).toEqual([entry!.seq])

    // Reconnect-equivalent: the transport works again; resendPending delivers + acks.
    h.setSendMode('plain-accepted')
    await h.coordinator.resendPending()
    expect(await pendingSeqs()).toEqual([])
  })

  it('TC-T6: a sync-request send failure cleans waiter + timer deterministically and resolves null', async () => {
    h.setSendMode('throw')
    vi.useFakeTimers()
    const page = await (h.coordinator as unknown as {
      requestSyncPage: (heads: Record<string, number>, timeoutMs?: number) => Promise<unknown>
    }).requestSyncPage({}, 500)
    expect(page).toBeNull()
    // No waiter leak until the timeout, no timer corpse (fake timers prove it).
    const pendingSyncRequests = (h.coordinator as unknown as { pendingSyncRequests: Map<string, unknown> })
      .pendingSyncRequests
    expect(pendingSyncRequests.size).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('TC-T7: a correlated AUTHOR_MISMATCH terminally retires the entry — resendPending sends nothing', async () => {
    h.setSendMode('throw')
    const entry = await h.coordinator.writeLocalUpdate(new Uint8Array([7, 8, 9]))
    expect(await pendingSeqs()).toEqual([entry!.seq])

    await expect(
      h.coordinator.handleWriteReject('AUTHOR_MISMATCH', DEVICE_A, entry!.seq),
    ).rejects.toBeInstanceOf(AuthorMismatchError)

    // onSecurityError parity (#236): AUTHOR_MISMATCH surfaces like the owner mismatch.
    expect(h.securityErrors.some((e) => e instanceof AuthorMismatchError)).toBe(true)

    // I-TERM: the entry is retired; a resendPending AFTER the settled reject sends nothing.
    expect(await pendingSeqs()).toEqual([])
    const sendsBefore = h.envelopeSends()
    h.setSendMode('plain-accepted')
    await h.coordinator.resendPending()
    expect(h.envelopeSends()).toBe(sendsBefore)
  })

  it('TC-T7: a correlated PERSONAL_DOC_OWNER_MISMATCH retires the entry the same way', async () => {
    h.setSendMode('throw')
    const entry = await h.coordinator.writeLocalUpdate(new Uint8Array([1, 1, 2]))

    await expect(
      h.coordinator.handleWriteReject('PERSONAL_DOC_OWNER_MISMATCH', DEVICE_A, entry!.seq),
    ).rejects.toBeInstanceOf(PersonalDocOwnerMismatchError)
    expect(h.securityErrors.some((e) => e instanceof PersonalDocOwnerMismatchError)).toBe(true)
    expect(await pendingSeqs()).toEqual([])
  })

  it('TC-T7: an UNCORRELATED hard-stop (no seq) is not blindly acked — the entry stays pending and visible', async () => {
    h.setSendMode('throw')
    const entry = await h.coordinator.writeLocalUpdate(new Uint8Array([3, 1, 4]))

    await expect(
      h.coordinator.handleWriteReject('AUTHOR_MISMATCH', DEVICE_A, undefined),
    ).rejects.toBeInstanceOf(AuthorMismatchError)

    // No blind markAcked: the entry is still pending (visible, next correlated reject retires it).
    expect(await pendingSeqs()).toEqual([entry!.seq])
  })
})
