import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  INBOX_MESSAGE_TYPE,
  encodeBase64Url,
  isDidcommMessage,
  x25519PublicKeyToMultibase,
  x25519MultibaseToPublicKeyBytes,
  encryptionKeyMultibaseFromDidDocument,
  type DidDocument,
} from '@web_of_trust/core/protocol'
import {
  InMemoryMessagingAdapter,
  InMemoryOutboxStore,
  OutboxMessagingAdapter,
  InMemoryGraphCacheStore,
  InMemoryPublishStateStore,
  OfflineFirstDiscoveryAdapter,
} from '@web_of_trust/core/adapters'
import type {
  Attestation,
  IdentitySession,
} from '@web_of_trust/core/types'
import type { DiscoveryAdapter } from '@web_of_trust/core/ports'
import { AttestationService, type AttestationStoragePort } from '../src/services/AttestationService'

// VE-9 (service-level): close the gap between "OfflineFirstDiscoveryAdapter
// reconstructs a didDocument offline" and "AttestationService actually enqueues
// the ECIES delivery". The recipient was resolved ONLINE earlier (key cached),
// then the device goes OFFLINE — the canonical key lookup
// (encryptionKeyMultibaseFromDidDocument) must still find the key so
// sendAttestation enqueues into the outbox (status 'queued') instead of throwing
// 'No encryption key published' and dropping the attestation.

// A real bare did:key (ed25519) so the offline fallback's resolveDidKey rebuild
// actually succeeds — a fake DID would make resolveDidKey throw → didDocument:null.
const BOB_DID = 'did:key:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK'
const ALICE_DID = 'did:key:z6MkAlice1234567890abcdefghijklmnopqrstuvwxyz'
// A syntactically valid X25519 keyAgreement multibase (decodes to 32 bytes).
const ENC_MULTIBASE = x25519PublicKeyToMultibase(new Uint8Array(32).fill(7))

function bobDidDocument(): DidDocument {
  return {
    id: BOB_DID,
    verificationMethod: [],
    authentication: [],
    assertionMethod: [],
    keyAgreement: [{
      id: '#enc-0',
      type: 'X25519KeyAgreementKey2020',
      controller: BOB_DID,
      publicKeyMultibase: ENC_MULTIBASE,
    }],
  }
}

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

/** Inner adapter that is always offline for resolveProfile (HTTP fails). */
function createOfflineInner(): DiscoveryAdapter {
  return {
    publishProfile: vi.fn(async () => {}),
    publishAttestations: vi.fn(async () => {}),
    publishVerifications: vi.fn(async () => {}),
    resolveProfile: vi.fn(async () => { throw new Error('offline: network unreachable') }),
    resolveAttestations: vi.fn(async () => { throw new Error('offline') }),
    resolveVerifications: vi.fn(async () => { throw new Error('offline') }),
  }
}

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

describe('Offline ECIES delivery key resolution (VE-9 service-level)', () => {
  let aliceInner: InMemoryMessagingAdapter
  let bobAdapter: InMemoryMessagingAdapter
  let outboxStore: InMemoryOutboxStore
  let aliceMessaging: OutboxMessagingAdapter
  let storage: AttestationStoragePort
  let alice: IdentitySession
  let service: AttestationService
  let graphCache: InMemoryGraphCacheStore
  let discovery: OfflineFirstDiscoveryAdapter

  beforeEach(async () => {
    InMemoryMessagingAdapter.resetAll()

    aliceInner = new InMemoryMessagingAdapter()
    bobAdapter = new InMemoryMessagingAdapter()
    outboxStore = new InMemoryOutboxStore()
    aliceMessaging = new OutboxMessagingAdapter(aliceInner, outboxStore, {
      skipTypes: ['profile-update'],
      sendTimeoutMs: 500,
    })

    // Prefill the graph cache with Bob's keyAgreement key via a cacheEntry that
    // carries his didDocument — exactly what an ONLINE resolve / verification /
    // contact-sync would have cached (VE-3/VE-7).
    graphCache = new InMemoryGraphCacheStore()
    await graphCache.cacheEntry(BOB_DID, {
      profile: { did: BOB_DID, name: 'Bob', updatedAt: new Date().toISOString() },
      attestations: [],
      verifications: [],
      didDocument: bobDidDocument(),
    })

    // Discovery is OFFLINE: inner resolveProfile rejects, so the adapter falls
    // back to the cache and must reconstruct Bob's didDocument from the key.
    discovery = new OfflineFirstDiscoveryAdapter(
      createOfflineInner(),
      new InMemoryPublishStateStore(),
      graphCache,
    )

    storage = createMockStorage()
    alice = createMockIdentity(ALICE_DID)
    service = new AttestationService(storage)
    service.setMessaging(aliceMessaging)
    // The DELIVERY resolver is the canonical lookup wired in AdapterContext: it
    // routes the offline-reconstructed didDocument through the validating helper.
    service.configureDelivery({
      identity: alice,
      resolveRecipientEncryptionKey: async (recipientDid) => {
        const result = await discovery.resolveProfile(recipientDid)
        const enc = encryptionKeyMultibaseFromDidDocument(result.didDocument)
        return enc ? x25519MultibaseToPublicKeyBytes(enc) : null
      },
    })

    await bobAdapter.connect(BOB_DID)
    await aliceMessaging.connect(ALICE_DID)
  })

  afterEach(() => {
    InMemoryMessagingAdapter.resetAll()
  })

  it('offline resolveProfile reconstructs Bob\'s didDocument with the cached keyAgreement key', async () => {
    const result = await discovery.resolveProfile(BOB_DID)
    expect(result.fromCache).toBe(true)
    expect(result.didDocument).not.toBeNull()
    expect(result.didDocument!.keyAgreement[0].publicKeyMultibase).toBe(ENC_MULTIBASE)
  })

  it('the delivery resolver returns 32 ECIES bytes offline (not null)', async () => {
    const resolver = service['deliveryConfig']!.resolveRecipientEncryptionKey
    const bytes = await resolver(BOB_DID)
    expect(bytes).not.toBeNull()
    expect(bytes).toBeInstanceOf(Uint8Array)
    expect(bytes!.length).toBe(32)
  })

  it('sendAttestation enqueues the ECIES delivery offline instead of throwing "No encryption key published"', async () => {
    // Go offline at the messaging layer too → the wire send queues in the outbox.
    await aliceMessaging.disconnect()
    const attestation = makeAttestation()

    // MUST NOT throw — the key is resolvable offline, so the attestation is
    // ECIES-wrapped and enqueued for delivery on reconnect.
    await expect(
      service.sendAttestation(alice, attestation),
    ).resolves.toBeUndefined()

    expect(service.getDeliveryStatus(attestation.id)).toBe('queued')
    expect(service.getDeliveryStatus(attestation.id)).not.toBe('failed')
    // The ECIES envelope reached the outbox (not dropped before enqueue).
    expect(await outboxStore.count()).toBe(1)
  })

  it('sendAttestation delivers the ECIES inbox/1.0 envelope when online (resolver still offline)', async () => {
    // Messaging is connected (online), but discovery is offline → the recipient
    // key still comes from the reconstructed cache. The wire envelope must be a
    // DIDComm inbox/1.0 message with an ECIES body addressed to Bob.
    const received: unknown[] = []
    const messageReceived = new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Timed out waiting for inbox delivery')), 500)
      bobAdapter.onMessage((message) => {
        received.push(message)
        clearTimeout(timeout)
        resolve()
      })
    })

    const attestation = makeAttestation()
    await service.sendAttestation(alice, attestation)
    await messageReceived

    expect(received).toHaveLength(1)
    const envelope = received[0] as Record<string, unknown>
    expect(isDidcommMessage(envelope)).toBe(true)
    expect(envelope.type).toBe(INBOX_MESSAGE_TYPE)
    expect(envelope.to).toEqual([BOB_DID])
    expect(['queued', 'delivered']).toContain(service.getDeliveryStatus(attestation.id))
  })

  it('without a cached key the resolver returns null and sendAttestation surfaces the failure (no silent drop)', async () => {
    // A recipient that was never resolved online → no cached key → offline
    // fallback yields didDocument:null → resolver null → throw + status failed.
    const UNKNOWN_DID = 'did:key:z6MknGc3ocHs3zdPiJbnaaqDi58NGb4pk1Sp9WxWufuXSdxf'
    const attestation: Attestation = { ...makeAttestation(), to: UNKNOWN_DID, id: 'urn:uuid:00000000-0000-4000-8000-000000000001' }

    await expect(
      service.sendAttestation(alice, attestation),
    ).rejects.toThrow(`No encryption key published for ${UNKNOWN_DID}`)
    expect(service.getDeliveryStatus(attestation.id)).toBe('failed')
  })
})
