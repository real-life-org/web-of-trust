import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  INBOX_MESSAGE_TYPE,
  encodeBase64Url,
  isDidcommMessage,
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
// Gültiger X25519-Public-Key-Input (32 Bytes) für den ECIES-Wrap im Test.
const RECIPIENT_ENCRYPTION_KEY = new Uint8Array(32).fill(7)
const testDir = path.dirname(fileURLToPath(import.meta.url))
const demoRoot = path.resolve(testDir, '..')

/**
 * Poll `predicate` until it holds or `timeoutMs` elapses, instead of a fixed sleep.
 * The attestation send path is fire-and-forget (inner-JWS + ECIES + relay deliver),
 * so a fixed `setTimeout` races a slower/contended CI runner — the cause of the
 * flaky `demo#test`. Polling the actual asserted condition makes delivery assertions
 * deterministic while staying fast on a quick machine.
 */
async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  { timeoutMs = 2000, stepMs = 10 }: { timeoutMs?: number; stepMs?: number } = {},
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (await predicate()) return
    if (Date.now() >= deadline) return // let the following expect() produce the diff
    await new Promise((r) => setTimeout(r, stepMs))
  }
}

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
    // K2-Versand braucht den X25519-Key des Empfängers (Sync 004 keyAgreement).
    service.configureDelivery({
      identity: alice,
      resolveRecipientEncryptionKey: async () => RECIPIENT_ENCRYPTION_KEY,
    })

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

  it('sends attestations as DIDComm inbox/1.0 with an ECIES body (K2 — no plaintext attestation on the wire)', async () => {
    const received: unknown[] = []
    bobAdapter.onMessage((message) => { received.push(message) })

    const attestation = await service.createAttestation(alice, BOB_DID, 'Great person')
    await waitFor(() => received.length === 1)

    expect(received).toHaveLength(1)
    const envelope = received[0] as Record<string, unknown>
    expect(isDidcommMessage(envelope)).toBe(true)
    expect(envelope.type).toBe(INBOX_MESSAGE_TYPE)
    expect(envelope.to).toEqual([BOB_DID])
    expect(Object.keys(envelope.body as object)).toEqual(
      expect.arrayContaining(['epk', 'nonce', 'ciphertext']),
    )
    // Deterministische Message-ID: UUID aus urn:uuid:<uuid> (Receipt-/Outbox-Zuordnung).
    expect(`urn:uuid:${envelope.id}`).toBe(attestation.id)
    // Kein Klartext-Attestation-Objekt im Wire-Body (K2).
    expect(JSON.stringify(envelope.body)).not.toContain('"claim"')
  })

  it('should set status to "delivered" when receipt comes back', async () => {
    service.listenForReceipts(aliceMessaging)

    const attestation = await service.createAttestation(alice, BOB_DID, 'Great person')
    // InMemoryMessagingAdapter delivers synchronously and returns 'accepted' receipt
    // The 'delivered' receipt comes via onReceipt callback
    await waitFor(() => service.getDeliveryStatus(attestation.id) === 'delivered')

    const status = service.getDeliveryStatus(attestation.id)
    expect(status).toBe('delivered')
  })

  it('should set status to "queued" when offline', async () => {
    await aliceMessaging.disconnect()

    service.listenForReceipts(aliceMessaging)

    const attestation = await service.createAttestation(alice, BOB_DID, 'Great person')
    await waitFor(() => service.getDeliveryStatus(attestation.id) === 'queued')

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
    await waitFor(() => service.getDeliveryStatus(attestation.id) === 'failed')

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
    await waitFor(() => updates.length > 0)

    expect(updates.length).toBeGreaterThan(0)
  })

  it('retryAttestation() should resend and update status', async () => {
    await aliceMessaging.disconnect()
    service.listenForReceipts(aliceMessaging)

    const attestation = await service.createAttestation(alice, BOB_DID, 'Great person')
    await waitFor(() => service.getDeliveryStatus(attestation.id) === 'queued')
    expect(service.getDeliveryStatus(attestation.id)).toBe('queued')

    // Reconnect
    await aliceMessaging.connect(ALICE_DID)
    // Give auto-flush time
    await new Promise((r) => setTimeout(r, 100))

    // Now retry
    await service.retryAttestation(attestation.id)
    await waitFor(() => ['sending', 'delivered'].includes(service.getDeliveryStatus(attestation.id) as string))

    const status = service.getDeliveryStatus(attestation.id)
    expect(['sending', 'delivered']).toContain(status)
  })

  // --- M-B: kein stiller Attestationsverlust beim Versand ---

  function makeAttestation(): Attestation {
    return {
      id: 'urn:uuid:7a1c2f80-aabb-4cdd-9eef-112233445566',
      from: ALICE_DID,
      to: BOB_DID,
      claim: 'in-person verifiziert',
      createdAt: '2026-06-10T10:00:00Z',
      vcJws: 'aGVhZGVy.cGF5bG9hZA.c2lnbmF0dXJl',
    }
  }

  it('M-B: sendAttestation uses an explicit recipient key without a discovery roundtrip', async () => {
    // Verification-Flow: der Peer-Key kommt aus dem QR-Challenge-Payload
    // (Trust 002 `enc`) — Discovery (Peer-Profil evtl. nie publiziert) darf
    // nicht auf dem Versandpfad liegen.
    const resolver = vi.fn(async () => null)
    service.configureDelivery({ identity: alice, resolveRecipientEncryptionKey: resolver })
    const received: unknown[] = []
    bobAdapter.onMessage((message) => { received.push(message) })

    const attestation = makeAttestation()
    await service.sendAttestation(alice, attestation, { recipientEncryptionKey: RECIPIENT_ENCRYPTION_KEY })
    await waitFor(() => received.length === 1)

    expect(resolver).not.toHaveBeenCalled()
    expect(received).toHaveLength(1)
    expect((received[0] as { type: string }).type).toBe(INBOX_MESSAGE_TYPE)
    expect(['queued', 'delivered']).toContain(service.getDeliveryStatus(attestation.id))
  })

  it('M-B: sendAttestation with an explicit recipient key queues in the outbox when offline', async () => {
    await aliceMessaging.disconnect()
    const attestation = makeAttestation()

    await service.sendAttestation(alice, attestation, { recipientEncryptionKey: RECIPIENT_ENCRYPTION_KEY })

    expect(service.getDeliveryStatus(attestation.id)).toBe('queued')
    expect(await outboxStore.count()).toBe(1)
  })

  it('M-B: sendAttestation surfaces a missing recipient key as failed status and rejects', async () => {
    // Old-World hat gequeued; ohne Empfänger-Key ist keine spec-konforme
    // Zustellung möglich (Sync 003 Z.446-456) — aber der Fehler muss sichtbar
    // werden (Status 'failed' + Retry), kein Silent-Drop mit UI "done".
    service.configureDelivery({ identity: alice, resolveRecipientEncryptionKey: async () => null })
    const attestation = makeAttestation()

    await expect(
      service.sendAttestation(alice, attestation),
    ).rejects.toThrow(`No encryption key published for ${BOB_DID}`)

    expect(service.getDeliveryStatus(attestation.id)).toBe('failed')
  })

  it('initFromOutbox() should mark pending outbox entries as "queued"', async () => {
    // Queue a message in outbox while disconnected
    await aliceMessaging.disconnect()
    await service.createAttestation(alice, BOB_DID, 'Great person')
    // Der Versand (Inner-JWS + ECIES) läuft fire-and-forget — auf das Enqueue warten.
    await waitFor(async () => (await outboxStore.count()) === 1)

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
