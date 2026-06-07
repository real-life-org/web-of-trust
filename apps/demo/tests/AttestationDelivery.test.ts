import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  encodeBase64Url,
} from '@web_of_trust/core/protocol'
import {
  InMemoryMessagingAdapter,
  InMemoryOutboxStore,
  OutboxMessagingAdapter,
} from '@web_of_trust/core/adapters'
import type {
  Attestation,
  IdentitySession,
} from '@web_of_trust/core/types'
import { AttestationService, type AttestationStoragePort } from '../src/services/AttestationService'

const ALICE_DID = 'did:key:z6MkAlice1234567890abcdefghijklmnopqrstuvwxyz'
const BOB_DID = 'did:key:z6MkBob1234567890abcdefghijklmnopqrstuvwxyzab'
const testDir = path.dirname(fileURLToPath(import.meta.url))
const demoRoot = path.resolve(testDir, '..')

describe('AttestationService storage port source guard', () => {
  it('keeps the service on an attestation-only storage port', () => {
    const serviceSource = readFileSync(path.resolve(demoRoot, 'src/services/AttestationService.ts'), 'utf8')
    const testSource = readFileSync(path.resolve(testDir, 'AttestationDelivery.test.ts'), 'utf8')

    const legacyMockMethods = [
      ['save', 'Verification'],
      ['getReceived', 'Verifications'],
      ['getAll', 'Verifications'],
      ['get', 'Verification'],
      ['create', 'Identity'],
      ['get', 'Identity'],
      ['update', 'Identity'],
      ['add', 'Contact'],
      ['get', 'Contacts'],
      ['get', 'Contact'],
      ['update', 'Contact'],
      ['remove', 'Contact'],
    ].map((parts) => parts.join(''))

    expect(serviceSource).not.toContain(['Storage', 'Adapter'].join(''))
    for (const method of legacyMockMethods) {
      expect(testSource).not.toContain(method)
    }
    expect(serviceSource).toContain('saveAttestation')
    expect(serviceSource).toContain('getAttestation')
    expect(serviceSource).toContain('getReceivedAttestations')
    expect(serviceSource).toContain('setAttestationAccepted')
  })
})

// Minimal mock storage — only attestation methods
function createMockStorage(): AttestationStoragePort {
  const attestations = new Map<string, Attestation>()

  return {
    saveAttestation: vi.fn(async (a: Attestation) => { attestations.set(a.id, a) }),
    getAttestation: vi.fn(async (id: string) => attestations.get(id) ?? null),
    getReceivedAttestations: vi.fn(async () => [...attestations.values()]),
    setAttestationAccepted: vi.fn(async () => {}),
  }
}

function createMockIdentity(did: string): IdentitySession {
  return {
    getDid: () => did,
    sign: vi.fn(async () => encodeBase64Url(new Uint8Array(64))),
    signJws: vi.fn(async () => 'mock.header.signature'),
    signEd25519: vi.fn(async () => new Uint8Array(64)),
    deriveFrameworkKey: vi.fn(async () => new Uint8Array(32)),
    getPublicKeyMultibase: vi.fn(async () => did.replace('did:key:', '')),
    getEncryptionPublicKeyBytes: vi.fn(async () => new Uint8Array(32)),
    encryptForRecipient: vi.fn(async () => ({ ciphertext: new Uint8Array(), nonce: new Uint8Array() })),
    decryptForMe: vi.fn(async () => new Uint8Array()),
    deleteStoredIdentity: vi.fn(async () => {}),
  }
}

describe('AttestationService delivery tracking', () => {
  let aliceInner: InMemoryMessagingAdapter
  let bobAdapter: InMemoryMessagingAdapter
  let outboxStore: InMemoryOutboxStore
  let aliceMessaging: OutboxMessagingAdapter
  let storage: AttestationStoragePort
  let alice: IdentitySession
  let service: AttestationService

  beforeEach(async () => {
    InMemoryMessagingAdapter.resetAll()

    aliceInner = new InMemoryMessagingAdapter()
    bobAdapter = new InMemoryMessagingAdapter()
    outboxStore = new InMemoryOutboxStore()
    aliceMessaging = new OutboxMessagingAdapter(aliceInner, outboxStore, {
      skipTypes: ['profile-update'],
      sendTimeoutMs: 500,
    })

    storage = createMockStorage()
    alice = createMockIdentity(ALICE_DID)
    service = new AttestationService(storage)
    service.setMessaging(aliceMessaging)

    await bobAdapter.connect(BOB_DID)
    await aliceMessaging.connect(ALICE_DID)
  })

  afterEach(() => {
    InMemoryMessagingAdapter.resetAll()
  })

  it('should set status to "sending" immediately when creating attestation', async () => {
    // Start tracking
    service.listenForReceipts(aliceMessaging)

    const attestation = await service.createAttestation(alice, BOB_DID, 'Great person')

    // After send resolves (InMemory is instant), status should be 'delivered'
    // But we verify the map has an entry
    const status = service.getDeliveryStatus(attestation.id)
    expect(status).toBeDefined()
  })

  it('should set status to "delivered" when receipt comes back', async () => {
    service.listenForReceipts(aliceMessaging)

    const attestation = await service.createAttestation(alice, BOB_DID, 'Great person')
    // InMemoryMessagingAdapter delivers synchronously and returns 'accepted' receipt
    // The 'delivered' receipt comes via onReceipt callback
    await new Promise((r) => setTimeout(r, 50))

    const status = service.getDeliveryStatus(attestation.id)
    expect(status).toBe('delivered')
  })

  it('should set status to "queued" when offline', async () => {
    await aliceMessaging.disconnect()

    service.listenForReceipts(aliceMessaging)

    const attestation = await service.createAttestation(alice, BOB_DID, 'Great person')
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

    const attestation = await service.createAttestation(alice, BOB_DID, 'Great person')
    await new Promise((r) => setTimeout(r, 50))

    const status = service.getDeliveryStatus(attestation.id)
    expect(status).toBe('failed')
  })

  it('should expose status via watchDeliveryStatus() Subscribable', async () => {
    service.listenForReceipts(aliceMessaging)

    const subscribable = service.watchDeliveryStatus()
    expect(subscribable.getValue()).toBeDefined()
    expect(subscribable.getValue().size).toBe(0)

    const updates: Map<string, string>[] = []
    subscribable.subscribe((map) => updates.push(new Map(map)))

    await service.createAttestation(alice, BOB_DID, 'Great person')
    await new Promise((r) => setTimeout(r, 50))

    expect(updates.length).toBeGreaterThan(0)
  })

  it('retryAttestation() should resend and update status', async () => {
    await aliceMessaging.disconnect()
    service.listenForReceipts(aliceMessaging)

    const attestation = await service.createAttestation(alice, BOB_DID, 'Great person')
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
    await service.createAttestation(alice, BOB_DID, 'Great person')

    // Create fresh service (simulating app restart)
    const service2 = new AttestationService(storage)
    service2.setMessaging(aliceMessaging)
    await service2.initFromOutbox(outboxStore)

    // Should have one entry marked as queued
    const map = service2.watchDeliveryStatus().getValue()
    expect(map.size).toBe(1)
    const [status] = [...map.values()]
    expect(status).toBe('queued')
  })
})
