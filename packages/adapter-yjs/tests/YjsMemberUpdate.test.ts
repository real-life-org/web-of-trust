import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import type { PublicIdentitySession } from '../../wot-core/src/application/identity'
import { createTestIdentity } from '../../wot-core/tests/helpers/identity-session'
import {
  InMemoryMessagingAdapter,
  InMemorySpaceMetadataStorage,
  InMemoryCompactStore,
  InMemoryKeyManagementAdapter,
} from '@web_of_trust/core/adapters'
import { MEMBER_UPDATE_MESSAGE_TYPE, KEY_ROTATION_MESSAGE_TYPE } from '@web_of_trust/core/protocol'
import { createSpaceKey, rotateSpaceKey, buildKeyRotationBody } from '@web_of_trust/core/application'
import { WebCryptoProtocolCryptoAdapter } from '@web_of_trust/core/protocol-adapters'
import { YjsReplicationAdapter } from '../src/YjsReplicationAdapter'

const ADMIN = 'did:key:z6MkAdminAdminAdmin'
const TARGET = 'did:key:z6MkTargetTargetTarget'
const STRANGER = 'did:key:z6MkStrangerStranger'

interface Harness {
  adapter: YjsReplicationAdapter
  alice: PublicIdentitySession
  metadata: InMemorySpaceMetadataStorage
  keyManagement: InMemoryKeyManagementAdapter
  compactStore: InMemoryCompactStore
}

async function setup(): Promise<Harness> {
  InMemoryMessagingAdapter.resetAll()
  const alice = (await createTestIdentity('mku-alice')).identity
  const messaging = new InMemoryMessagingAdapter()
  await messaging.connect(alice.getDid())
  const metadata = new InMemorySpaceMetadataStorage()
  const keyManagement = new InMemoryKeyManagementAdapter()
  const compactStore = new InMemoryCompactStore()
  const adapter = new YjsReplicationAdapter({ identity: alice, messaging, keyManagement, metadataStorage: metadata, compactStore })
  await adapter.start()
  return { adapter, alice, metadata, keyManagement, compactStore }
}

// Die Handler nehmen das DEKODIERTE Inbox-Ergebnis (receiveInboxMessage accept):
// senderDid ist der verifizierte Inner-JWS-Signer (S1), der Klartext-Body kommt
// aus dem Inner-JWS-Payload. Der Group-Key-Decrypt-Pfad ist tot (Sync 003 Z.500).
function memberUpdateDecoded(senderDid: string, body: Record<string, unknown>) {
  return {
    type: MEMBER_UPDATE_MESSAGE_TYPE,
    senderDid,
    body,
    outerId: crypto.randomUUID(),
    extensionFields: {},
  }
}

function spaceState(adapter: YjsReplicationAdapter, spaceId: string): any {
  return (adapter as unknown as { spaces: Map<string, any> }).spaces.get(spaceId)
}

/**
 * Seedet die kanonische Membership ueber den produktiven Pfad (VE-1/VE-2):
 * createdBy in _meta (Admin-Approximation) + active@0-Events im grow-only
 * _members-Event-Set — die members-Projektion aktualisiert der Observer.
 */
function seedMembership(adapter: YjsReplicationAdapter, spaceId: string, creatorDid: string, memberDids: string[]): void {
  const doc = spaceState(adapter, spaceId).doc
  doc.transact(() => {
    doc.getMap('_meta').set('createdBy', creatorDid)
    const members = doc.getMap('_members')
    for (const did of memberDids) {
      members.set(`${did}:0:active`, { did, status: 'active', sinceGeneration: 0 })
    }
  }, 'local')
}

describe('YjsReplicationAdapter — member-update Authority-Split', () => {
  let h: Harness
  let spaceId: string

  beforeEach(async () => {
    h = await setup()
    const space = await h.adapter.createSpace('shared', {}, { name: 'S' })
    spaceId = space.id
    // createdBy is the SPEC-APPROX admin (VE-2). Make admin != local so localImpact is testable.
    seedMembership(h.adapter, spaceId, ADMIN, [ADMIN])
  })
  afterEach(async () => {
    await h.adapter.stop()
    InMemoryMessagingAdapter.resetAll()
    try { await h.alice.deleteStoredIdentity() } catch {}
  })

  it('admin-signed removal of another member → store-pending, sync requested, no local pendingRemoval', async () => {
    const syncSpy = vi.spyOn(h.adapter as any, 'requestSync').mockResolvedValue(undefined)
    const decoded = memberUpdateDecoded(ADMIN, { spaceId, action: 'removed', memberDid: TARGET, effectiveKeyGeneration: 0 })
    const outcome = await (h.adapter as any).handleMemberUpdate(decoded)

    const seen = await (h.adapter as any).memberUpdateStore.listSeenForSpace(spaceId)
    expect(seen).toHaveLength(1)
    expect(seen[0].storedDisposition).toBe('store-pending-and-sync')
    expect(syncSpy).toHaveBeenCalledWith(spaceId)
    expect(spaceState(h.adapter, spaceId).pendingRemoval).toBeUndefined()
    // STOP-10-Mapping: Signal recorded → applied/durable → ack.
    expect(outcome).toEqual({ kind: 'applied', durable: true })
  })

  it('K3: admin-signed removal of the LOCAL did marks pendingRemoval but keeps durable state', async () => {
    const deleteSpy = vi.spyOn(h.metadata, 'deleteSpaceMetadata')
    const decoded = memberUpdateDecoded(ADMIN, { spaceId, action: 'removed', memberDid: h.alice.getDid(), effectiveKeyGeneration: 0 })
    await (h.adapter as any).handleMemberUpdate(decoded)

    expect(spaceState(h.adapter, spaceId).pendingRemoval).toEqual({ effectiveKeyGeneration: 0 })
    // durable state survives — no destroy / delete (Sync 005 Z.191)
    expect(spaceState(h.adapter, spaceId)).toBeDefined()
    expect(spaceState(h.adapter, spaceId).doc).toBeDefined()
    expect(deleteSpy).not.toHaveBeenCalled()
  })

  it('future generation (> local+1) buffers without local impact (Sync 005 Z.205)', async () => {
    const decoded = memberUpdateDecoded(ADMIN, { spaceId, action: 'removed', memberDid: h.alice.getDid(), effectiveKeyGeneration: 5 })
    const outcome = await (h.adapter as any).handleMemberUpdate(decoded)

    expect(await (h.adapter as any).memberUpdateStore.listFutureForSpace(spaceId)).toHaveLength(1)
    expect(await (h.adapter as any).memberUpdateStore.listSeenForSpace(spaceId)).toHaveLength(0)
    expect(spaceState(h.adapter, spaceId).pendingRemoval).toBeUndefined()
    // buffer-future ist ackable (Signal durably im Store) → applied/durable.
    expect(outcome).toEqual({ kind: 'applied', durable: true })
  })

  it('Anti-Regression: non-admin removal is stored unverified with no local UX impact (Z.183-184)', async () => {
    const decoded = memberUpdateDecoded(STRANGER, { spaceId, action: 'removed', memberDid: h.alice.getDid(), effectiveKeyGeneration: 0 })
    await (h.adapter as any).handleMemberUpdate(decoded)

    const seen = await (h.adapter as any).memberUpdateStore.listSeenForSpace(spaceId)
    expect(seen).toHaveLength(1)
    expect(seen[0].storedDisposition).toBe('store-unverified-pending-and-sync')
    expect(spaceState(h.adapter, spaceId).pendingRemoval).toBeUndefined()
  })

  it('malformed body is rejected (no ack, nothing stored)', async () => {
    const decoded = memberUpdateDecoded(ADMIN, { spaceId, action: 'sideways', memberDid: TARGET, effectiveKeyGeneration: 0 })
    const outcome = await (h.adapter as any).handleMemberUpdate(decoded)
    expect(await (h.adapter as any).memberUpdateStore.listSeenForSpace(spaceId)).toHaveLength(0)
    expect(outcome).toMatchObject({ kind: 'invalid-rejected', rejection: 'malformed' })
  })

  it('unknown space → pending/not-buffered (kein ack, Relay-Redelivery bis der Invite kommt)', async () => {
    const unknownSpaceId = crypto.randomUUID()
    const decoded = memberUpdateDecoded(ADMIN, { spaceId: unknownSpaceId, action: 'removed', memberDid: TARGET, effectiveKeyGeneration: 0 })
    const outcome = await (h.adapter as any).handleMemberUpdate(decoded)
    expect(outcome).toEqual({
      kind: 'pending',
      durability: 'not-buffered',
      dependencies: [{ kind: 'missing-space-invite', docId: unknownSpaceId }],
    })
  })
})

describe('YjsReplicationAdapter — #181 (b) saveSpaceMetadata fingerprint', () => {
  let h: Harness
  let spaceId: string

  beforeEach(async () => {
    h = await setup()
    const space = await h.adapter.createSpace('shared', {}, { name: 'S' })
    spaceId = space.id
  })
  afterEach(async () => {
    await h.adapter.stop()
    InMemoryMessagingAdapter.resetAll()
    try { await h.alice.deleteStoredIdentity() } catch {}
  })

  it('a rotated key (same DID, different bytes) changes the fingerprint and re-writes', async () => {
    const state = spaceState(h.adapter, spaceId)
    const saveSpy = vi.spyOn(h.metadata, 'saveSpaceMetadata')

    state.memberEncryptionKeys.set(TARGET, new Uint8Array(32).fill(1))
    await (h.adapter as any).saveSpaceMetadata(state)
    state.memberEncryptionKeys.set(TARGET, new Uint8Array(32).fill(2)) // same DID, different bytes
    await (h.adapter as any).saveSpaceMetadata(state)

    expect(saveSpy).toHaveBeenCalledTimes(2)
  })

  it('image / modules / appTag changes change the fingerprint and re-write', async () => {
    const state = spaceState(h.adapter, spaceId)
    await (h.adapter as any).saveSpaceMetadata(state)
    const saveSpy = vi.spyOn(h.metadata, 'saveSpaceMetadata')

    state.info.image = 'data:image/png;base64,AAAA'
    await (h.adapter as any).saveSpaceMetadata(state)
    state.info.modules = ['notes']
    await (h.adapter as any).saveSpaceMetadata(state)
    state.info.appTag = 'wot-demo'
    await (h.adapter as any).saveSpaceMetadata(state)

    expect(saveSpy).toHaveBeenCalledTimes(3)
  })
})

describe('YjsReplicationAdapter — member-update review fixes', () => {
  let h: Harness
  let spaceId: string

  beforeEach(async () => {
    h = await setup()
    const space = await h.adapter.createSpace('shared', {}, { name: 'S' })
    spaceId = space.id
    seedMembership(h.adapter, spaceId, ADMIN, [ADMIN])
  })
  afterEach(async () => {
    await h.adapter.stop()
    InMemoryMessagingAdapter.resetAll()
    try { await h.alice.deleteStoredIdentity() } catch {}
  })

  it('pendingAddition and pendingRemoval are mutually exclusive', async () => {
    // Generation 1: fuer beide Pendings traegt das Event-Set (alice active@0)
    // noch keine Antwort — die Review-M1-Sofortaufloesung greift nicht, die
    // Flags bleiben als Pending-UX stehen (Sync 005 Z.183-184).
    const local = h.alice.getDid()
    await (h.adapter as any).handleMemberUpdate(memberUpdateDecoded(ADMIN,
      { spaceId, action: 'added', memberDid: local, effectiveKeyGeneration: 1 }))
    expect(spaceState(h.adapter, spaceId).pendingAddition).toBeDefined()

    await (h.adapter as any).handleMemberUpdate(memberUpdateDecoded(ADMIN,
      { spaceId, action: 'removed', memberDid: local, effectiveKeyGeneration: 1 }))
    expect(spaceState(h.adapter, spaceId).pendingRemoval).toBeDefined()
    expect(spaceState(h.adapter, spaceId).pendingAddition).toBeUndefined()
  })
})

describe('YjsReplicationAdapter — key-rotation future-buffer ohne durablen Store', () => {
  it('liefert pending/not-buffered (kein ack) statt zu werfen — Redelivery ist der Recovery-Pfad', async () => {
    InMemoryMessagingAdapter.resetAll()
    const protocolCrypto = new WebCryptoProtocolCryptoAdapter()
    const alice = (await createTestIdentity('mku-nodurable')).identity
    const admin = (await createTestIdentity('mku-admin')).identity
    const messaging = new InMemoryMessagingAdapter()
    await messaging.connect(alice.getDid())
    // No compactStore → no durable pending store.
    const adapter = new YjsReplicationAdapter({ identity: alice, messaging, keyManagement: new InMemoryKeyManagementAdapter() })
    await adapter.start()
    const space = await adapter.createSpace('shared', {}, { name: 'S' })
    seedMembership(adapter, space.id, admin.getDid(), [admin.getDid()])

    // Self-consistent gen-5-Rotation (future: local gen ist 0) vom Admin.
    const port = new InMemoryKeyManagementAdapter()
    await createSpaceKey({ crypto: protocolCrypto, keyPort: port, spaceId: space.id, ownerDid: admin.getDid() })
    for (let i = 0; i < 5; i++) {
      await rotateSpaceKey({ crypto: protocolCrypto, keyPort: port, spaceId: space.id, ownerDid: admin.getDid() })
    }
    const body = await buildKeyRotationBody({ keyPort: port, spaceId: space.id, newGeneration: 5, recipientDid: alice.getDid() })

    const outcome = await (adapter as any).handleKeyRotation({
      type: KEY_ROTATION_MESSAGE_TYPE,
      senderDid: admin.getDid(),
      body: body as unknown as Record<string, unknown>,
      outerId: crypto.randomUUID(),
      extensionFields: {},
    })
    expect(outcome).toEqual({
      kind: 'pending',
      durability: 'not-buffered',
      dependencies: [{ kind: 'missing-key-generation', docId: space.id, keyGeneration: 4 }],
    })

    await adapter.stop()
    try { await alice.deleteStoredIdentity() } catch {}
    try { await admin.deleteStoredIdentity() } catch {}
  })
})
