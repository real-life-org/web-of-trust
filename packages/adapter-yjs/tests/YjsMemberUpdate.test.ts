import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import type { PublicIdentitySession } from '../../wot-core/src/application/identity'
import { createTestIdentity } from '../../wot-core/tests/helpers/identity-session'
import {
  InMemoryMessagingAdapter,
  InMemorySpaceMetadataStorage,
  InMemoryCompactStore,
  InMemoryKeyManagementAdapter,
} from '@web_of_trust/core/adapters'
import { encryptOneShot } from '@web_of_trust/core/protocol'
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

function memberUpdateEnvelope(fromDid: string, payload: unknown, toDid: string) {
  return {
    v: 1, id: crypto.randomUUID(), type: 'member-update',
    fromDid, toDid, createdAt: new Date().toISOString(), encoding: 'json' as const,
    payload: JSON.stringify(payload), signature: '',
  }
}

function spaceState(adapter: YjsReplicationAdapter, spaceId: string): any {
  return (adapter as unknown as { spaces: Map<string, any> }).spaces.get(spaceId)
}

describe('YjsReplicationAdapter — member-update Authority-Split', () => {
  let h: Harness
  let spaceId: string

  beforeEach(async () => {
    h = await setup()
    const space = await h.adapter.createSpace('shared', {}, { name: 'S' })
    spaceId = space.id
    // members[0] is the SPEC-APPROX admin. Make admin != local so localImpact is testable.
    spaceState(h.adapter, spaceId).info.members = [ADMIN, h.alice.getDid()]
  })
  afterEach(async () => {
    await h.adapter.stop()
    InMemoryMessagingAdapter.resetAll()
    try { await h.alice.deleteStoredIdentity() } catch {}
  })

  it('admin-signed removal of another member → store-pending, sync requested, no local pendingRemoval', async () => {
    const syncSpy = vi.spyOn(h.adapter as any, 'requestSync').mockResolvedValue(undefined)
    const env = memberUpdateEnvelope(ADMIN, { spaceId, action: 'removed', memberDid: TARGET, effectiveKeyGeneration: 0 }, h.alice.getDid())
    await (h.adapter as any).handleMemberUpdate(env)

    const seen = await (h.adapter as any).memberUpdateStore.listSeenForSpace(spaceId)
    expect(seen).toHaveLength(1)
    expect(seen[0].storedDisposition).toBe('store-pending-and-sync')
    expect(syncSpy).toHaveBeenCalledWith(spaceId)
    expect(spaceState(h.adapter, spaceId).pendingRemoval).toBeUndefined()
  })

  it('K3: admin-signed removal of the LOCAL did marks pendingRemoval but keeps durable state', async () => {
    const deleteSpy = vi.spyOn(h.metadata, 'deleteSpaceMetadata')
    const env = memberUpdateEnvelope(ADMIN, { spaceId, action: 'removed', memberDid: h.alice.getDid(), effectiveKeyGeneration: 0 }, h.alice.getDid())
    await (h.adapter as any).handleMemberUpdate(env)

    expect(spaceState(h.adapter, spaceId).pendingRemoval).toEqual({ effectiveKeyGeneration: 0 })
    // durable state survives — no destroy / delete (Sync 005 Z.191)
    expect(spaceState(h.adapter, spaceId)).toBeDefined()
    expect(spaceState(h.adapter, spaceId).doc).toBeDefined()
    expect(deleteSpy).not.toHaveBeenCalled()
  })

  it('future generation (> local+1) buffers without local impact (Sync 005 Z.205)', async () => {
    const env = memberUpdateEnvelope(ADMIN, { spaceId, action: 'removed', memberDid: h.alice.getDid(), effectiveKeyGeneration: 5 }, h.alice.getDid())
    await (h.adapter as any).handleMemberUpdate(env)

    expect(await (h.adapter as any).memberUpdateStore.listFutureForSpace(spaceId)).toHaveLength(1)
    expect(await (h.adapter as any).memberUpdateStore.listSeenForSpace(spaceId)).toHaveLength(0)
    expect(spaceState(h.adapter, spaceId).pendingRemoval).toBeUndefined()
  })

  it('Anti-Regression: non-admin removal is stored unverified with no local UX impact (Z.183-184)', async () => {
    const env = memberUpdateEnvelope(STRANGER, { spaceId, action: 'removed', memberDid: h.alice.getDid(), effectiveKeyGeneration: 0 }, h.alice.getDid())
    await (h.adapter as any).handleMemberUpdate(env)

    const seen = await (h.adapter as any).memberUpdateStore.listSeenForSpace(spaceId)
    expect(seen).toHaveLength(1)
    expect(seen[0].storedDisposition).toBe('store-unverified-pending-and-sync')
    expect(spaceState(h.adapter, spaceId).pendingRemoval).toBeUndefined()
  })

  it('malformed body is rejected (ignored), no pending stored', async () => {
    const env = memberUpdateEnvelope(ADMIN, { spaceId, action: 'sideways', memberDid: TARGET, effectiveKeyGeneration: 0 }, h.alice.getDid())
    await (h.adapter as any).handleMemberUpdate(env)
    expect(await (h.adapter as any).memberUpdateStore.listSeenForSpace(spaceId)).toHaveLength(0)
  })
})

describe('YjsReplicationAdapter — #181 (a) member-update buffering + replay', () => {
  let h: Harness
  let spaceId: string
  const crypto2 = new WebCryptoProtocolCryptoAdapter()

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

  async function encryptedEnvelope(generation: number, body: unknown, key: Uint8Array) {
    const plaintext = new TextEncoder().encode(JSON.stringify(body))
    const enc = await encryptOneShot({ crypto: crypto2, spaceContentKey: key, plaintext })
    return memberUpdateEnvelope(h.alice.getDid(), {
      encrypted: true, spaceId, generation,
      ciphertext: Array.from(enc.ciphertextTag), nonce: Array.from(enc.nonce),
    }, h.alice.getDid())
  }

  function pending(adapter: YjsReplicationAdapter): any[] {
    return (adapter as unknown as { pendingMessages: Map<string, any[]> }).pendingMessages.get(spaceId) ?? []
  }

  it('buffers an encrypted member-update when the group key is missing (no drop)', async () => {
    const key = new Uint8Array(32).fill(7)
    const env = await encryptedEnvelope(99, { spaceId, action: 'removed', memberDid: TARGET, effectiveKeyGeneration: 99 }, key)
    await (h.adapter as any).handleMemberUpdate(env)
    expect(pending(h.adapter)).toHaveLength(1)
    expect(pending(h.adapter)[0].reason).toBe('blocked-by-key')
  })

  it('replays the buffered member-update after the key arrives', async () => {
    const key = new Uint8Array(32).fill(7)
    const env = await encryptedEnvelope(99, { spaceId, action: 'removed', memberDid: TARGET, effectiveKeyGeneration: 99 }, key)
    await (h.adapter as any).handleMemberUpdate(env)
    expect(pending(h.adapter)).toHaveLength(1)

    await h.keyManagement.saveKey(spaceId, 99, key)
    await (h.adapter as any).processPendingForSpace(spaceId)

    // decrypt succeeded → processMemberUpdate ran (alice == members[0] admin → store-pending)
    expect(await (h.adapter as any).memberUpdateStore.listSeenForSpace(spaceId)).toHaveLength(1)
    expect(pending(h.adapter)).toHaveLength(0)
  })

  it('anti-loop: a wrong key on replay drops the message instead of re-buffering', async () => {
    const key = new Uint8Array(32).fill(7)
    const env = await encryptedEnvelope(99, { spaceId, action: 'removed', memberDid: TARGET, effectiveKeyGeneration: 99 }, key)
    await (h.adapter as any).handleMemberUpdate(env)

    await h.keyManagement.saveKey(spaceId, 99, new Uint8Array(32).fill(9)) // wrong key
    await (h.adapter as any).processPendingForSpace(spaceId)

    expect(pending(h.adapter)).toHaveLength(0) // not retried, not re-buffered
    expect(await (h.adapter as any).memberUpdateStore.listSeenForSpace(spaceId)).toHaveLength(0)
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
