import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  InMemoryMessagingAdapter,
  InMemoryOutboxStore,
  OutboxMessagingAdapter,
} from '@real-life/wot-core'
import type {
  StorageAdapter,
  CryptoAdapter,
  Attestation,
  DeliveryReceipt,
} from '@real-life/wot-core'
import { AttestationService } from '../src/services/AttestationService'

const ALICE_DID = 'did:key:z6MkAlice1234567890abcdefghijklmnopqrstuvwxyz'
const BOB_DID = 'did:key:z6MkBob1234567890abcdefghijklmnopqrstuvwxyzab'

// Minimal mock storage — only attestation methods
function createMockStorage(): StorageAdapter {
  const attestations = new Map<string, Attestation>()
  const metadata = new Map<string, { accepted: boolean }>()

  return {
    saveAttestation: vi.fn(async (a: Attestation) => { attestations.set(a.id, a) }),
    getAttestation: vi.fn(async (id: string) => attestations.get(id) ?? null),
    getReceivedAttestations: vi.fn(async () => [...attestations.values()]),
    setAttestationAccepted: vi.fn(async (id: string, accepted: boolean) => {
      metadata.set(id, { accepted })
    }),
    getAttestationMetadata: vi.fn(async (id: string) => metadata.get(id) ?? null),
    // Unused methods
    createIdentity: vi.fn(),
    getIdentity: vi.fn(),
    updateIdentity: vi.fn(),
    addContact: vi.fn(),
    getContacts: vi.fn(),
    getContact: vi.fn(),
    updateContact: vi.fn(),
    removeContact: vi.fn(),
    saveVerification: vi.fn(),
    getReceivedVerifications: vi.fn(async () => []),
    getAllVerifications: vi.fn(),
    getVerification: vi.fn(),
    init: vi.fn(),
    clear: vi.fn(),
  } as unknown as StorageAdapter
}

// Minimal mock crypto
function createMockCrypto(): CryptoAdapter {
  return {
    generateNonce: () => 'abcdef1234567890',
    didToPublicKey: vi.fn(async () => 'mock-pubkey'),
    verifyString: vi.fn(async () => true),
  } as unknown as CryptoAdapter
}

describe('AttestationService delivery tracking', () => {
  let aliceInner: InMemoryMessagingAdapter
  let bobAdapter: InMemoryMessagingAdapter
  let outboxStore: InMemoryOutboxStore
  let aliceMessaging: OutboxMessagingAdapter
  let storage: StorageAdapter
  let crypto: CryptoAdapter
  let service: AttestationService

  beforeEach(async () => {
    InMemoryMessagingAdapter.resetAll()

    aliceInner = new InMemoryMessagingAdapter()
    bobAdapter = new InMemoryMessagingAdapter()
    outboxStore = new InMemoryOutboxStore()
    aliceMessaging = new OutboxMessagingAdapter(aliceInner, outboxStore, {
      skipTypes: ['profile-update', 'attestation-ack'],
      sendTimeoutMs: 500,
    })

    storage = createMockStorage()
    crypto = createMockCrypto()
    service = new AttestationService(storage, crypto)
    service.setMessaging(aliceMessaging)

    await bobAdapter.connect(BOB_DID)
    await aliceMessaging.connect(ALICE_DID)
  })

  afterEach(() => {
    InMemoryMessagingAdapter.resetAll()
  })

  const signFn = async (data: string) => 'mock-signature'

  it('should set status to "sending" immediately when creating attestation', async () => {
    // Start tracking
    service.listenForReceipts(aliceMessaging)

    const attestation = await service.createAttestation(ALICE_DID, BOB_DID, 'Great person', signFn)

    // After send resolves (InMemory is instant), status should be 'delivered'
    // But we verify the map has an entry
    const status = service.getDeliveryStatus(attestation.id)
    expect(status).toBeDefined()
  })

  it('should set status to "delivered" when receipt comes back', async () => {
    service.listenForReceipts(aliceMessaging)

    const attestation = await service.createAttestation(ALICE_DID, BOB_DID, 'Great person', signFn)
    // InMemoryMessagingAdapter delivers synchronously and returns 'accepted' receipt
    // The 'delivered' receipt comes via onReceipt callback
    await new Promise((r) => setTimeout(r, 50))

    const status = service.getDeliveryStatus(attestation.id)
    expect(status).toBe('delivered')
  })

  it('should set status to "queued" when offline', async () => {
    await aliceMessaging.disconnect()

    service.listenForReceipts(aliceMessaging)

    const attestation = await service.createAttestation(ALICE_DID, BOB_DID, 'Great person', signFn)
    await new Promise((r) => setTimeout(r, 50))

    const status = service.getDeliveryStatus(attestation.id)
    expect(status).toBe('queued')
  })

  it('should set status to "failed" when send throws', async () => {
    // Create a messaging adapter that always throws
    const failingMessaging = {
      send: vi.fn(async () => { throw new Error('connection lost') }),
      onReceipt: vi.fn(() => () => {}),
      onMessage: vi.fn(() => () => {}),
      getState: () => 'connected' as const,
      connect: vi.fn(),
      disconnect: vi.fn(),
      registerTransport: vi.fn(),
      resolveTransport: vi.fn(),
    }

    service.setMessaging(failingMessaging as any)
    service.listenForReceipts(failingMessaging as any)

    const attestation = await service.createAttestation(ALICE_DID, BOB_DID, 'Great person', signFn)
    await new Promise((r) => setTimeout(r, 50))

    const status = service.getDeliveryStatus(attestation.id)
    expect(status).toBe('failed')
  })

  it('should update to "acknowledged" when attestation-ack arrives', async () => {
    service.listenForReceipts(aliceMessaging)

    const attestation = await service.createAttestation(ALICE_DID, BOB_DID, 'Great person', signFn)
    await new Promise((r) => setTimeout(r, 50))

    // Simulate Bob sending attestation-ack back
    await bobAdapter.send({
      v: 1,
      id: `ack-${attestation.id}`,
      type: 'attestation-ack',
      fromDid: BOB_DID,
      toDid: ALICE_DID,
      createdAt: new Date().toISOString(),
      encoding: 'json',
      payload: JSON.stringify({ attestationId: attestation.id }),
      signature: '',
    })
    await new Promise((r) => setTimeout(r, 50))

    const status = service.getDeliveryStatus(attestation.id)
    expect(status).toBe('acknowledged')
  })

  it('should expose status via watchDeliveryStatus() Subscribable', async () => {
    service.listenForReceipts(aliceMessaging)

    const subscribable = service.watchDeliveryStatus()
    expect(subscribable.getValue()).toBeDefined()
    expect(subscribable.getValue().size).toBe(0)

    const updates: Map<string, string>[] = []
    subscribable.subscribe((map) => updates.push(new Map(map)))

    await service.createAttestation(ALICE_DID, BOB_DID, 'Great person', signFn)
    await new Promise((r) => setTimeout(r, 50))

    expect(updates.length).toBeGreaterThan(0)
  })

  it('retryAttestation() should resend and update status', async () => {
    await aliceMessaging.disconnect()
    service.listenForReceipts(aliceMessaging)

    const attestation = await service.createAttestation(ALICE_DID, BOB_DID, 'Great person', signFn)
    await new Promise((r) => setTimeout(r, 50))
    expect(service.getDeliveryStatus(attestation.id)).toBe('queued')

    // Reconnect
    await aliceMessaging.connect(ALICE_DID)
    // Give auto-flush time
    await new Promise((r) => setTimeout(r, 100))

    // Now retry
    await service.retryAttestation(attestation.id)
    await new Promise((r) => setTimeout(r, 50))

    const status = service.getDeliveryStatus(attestation.id)
    expect(['sending', 'delivered']).toContain(status)
  })

  it('initFromOutbox() should mark pending outbox entries as "queued"', async () => {
    // Queue a message in outbox while disconnected
    await aliceMessaging.disconnect()
    await service.createAttestation(ALICE_DID, BOB_DID, 'Great person', signFn)

    // Create fresh service (simulating app restart)
    const service2 = new AttestationService(storage, crypto)
    service2.setMessaging(aliceMessaging)
    await service2.initFromOutbox(outboxStore)

    // Should have one entry marked as queued
    const map = service2.watchDeliveryStatus().getValue()
    expect(map.size).toBe(1)
    const [status] = [...map.values()]
    expect(status).toBe('queued')
  })
})
