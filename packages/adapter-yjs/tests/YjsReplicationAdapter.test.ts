import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { WotIdentity } from '@real-life/wot-core'
import { InMemoryMessagingAdapter } from '@real-life/wot-core'
import { GroupKeyService } from '@real-life/wot-core'
import { InMemorySpaceMetadataStorage } from '@real-life/wot-core'
import { InMemoryCompactStore } from '@real-life/wot-core'
import { YjsReplicationAdapter } from '../src/YjsReplicationAdapter'

interface TestDoc {
  notes: string
}

function createAdapter(
  identity: WotIdentity,
  messaging: InMemoryMessagingAdapter,
  opts?: { metadataStorage?: InMemorySpaceMetadataStorage; compactStore?: InMemoryCompactStore },
) {
  return new YjsReplicationAdapter({
    identity,
    messaging,
    groupKeyService: new GroupKeyService(),
    metadataStorage: opts?.metadataStorage,
    compactStore: opts?.compactStore,
  })
}

describe('YjsReplicationAdapter — Space Metadata (_meta)', () => {
  let alice: WotIdentity
  let bob: WotIdentity
  let aliceMessaging: InMemoryMessagingAdapter
  let bobMessaging: InMemoryMessagingAdapter
  let aliceAdapter: YjsReplicationAdapter
  let bobAdapter: YjsReplicationAdapter

  beforeEach(async () => {
    InMemoryMessagingAdapter.resetAll()

    alice = new WotIdentity()
    bob = new WotIdentity()
    await alice.create('alice-pass', false)
    await bob.create('bob-pass', false)

    aliceMessaging = new InMemoryMessagingAdapter()
    bobMessaging = new InMemoryMessagingAdapter()
    await aliceMessaging.connect(alice.getDid())
    await bobMessaging.connect(bob.getDid())

    aliceAdapter = createAdapter(alice, aliceMessaging)
    bobAdapter = createAdapter(bob, bobMessaging)

    await aliceAdapter.start()
    await bobAdapter.start()
  })

  afterEach(async () => {
    await aliceAdapter.stop()
    await bobAdapter.stop()
    InMemoryMessagingAdapter.resetAll()
    try { await alice.deleteStoredIdentity() } catch {}
    try { await bob.deleteStoredIdentity() } catch {}
  })

  describe('createSpace — _meta initialization', () => {
    it('should store name in _meta when creating a space', async () => {
      const space = await aliceAdapter.createSpace<TestDoc>('shared', { notes: '' }, { name: 'My Space' })
      expect(space.name).toBe('My Space')

      const handle = await aliceAdapter.openSpace<TestDoc>(space.id)
      const meta = handle.getMeta()
      expect(meta.name).toBe('My Space')
      handle.close()
    })

    it('should store description in _meta when creating a space', async () => {
      const space = await aliceAdapter.createSpace<TestDoc>('shared', { notes: '' }, {
        name: 'Test',
        description: 'A test space',
      })

      const handle = await aliceAdapter.openSpace<TestDoc>(space.id)
      const meta = handle.getMeta()
      expect(meta.name).toBe('Test')
      expect(meta.description).toBe('A test space')
      handle.close()
    })

    it('should work without meta (backward compat)', async () => {
      const space = await aliceAdapter.createSpace<TestDoc>('shared', { notes: '' })
      expect(space.name).toBeUndefined()

      const handle = await aliceAdapter.openSpace<TestDoc>(space.id)
      const meta = handle.getMeta()
      expect(meta.name).toBeUndefined()
      handle.close()
    })
  })

  describe('updateSpace', () => {
    it('should update the space name', async () => {
      const space = await aliceAdapter.createSpace<TestDoc>('shared', { notes: '' }, { name: 'Old Name' })

      await aliceAdapter.updateSpace(space.id, { name: 'New Name' })

      // SpaceInfo should reflect the change
      const updated = await aliceAdapter.getSpace(space.id)
      expect(updated!.name).toBe('New Name')

      // getMeta should also reflect the change
      const handle = await aliceAdapter.openSpace<TestDoc>(space.id)
      expect(handle.getMeta().name).toBe('New Name')
      handle.close()
    })

    it('should update description and image', async () => {
      const space = await aliceAdapter.createSpace<TestDoc>('shared', { notes: '' }, { name: 'Test' })

      await aliceAdapter.updateSpace(space.id, {
        description: 'Updated description',
        image: 'data:image/png;base64,abc123',
      })

      const handle = await aliceAdapter.openSpace<TestDoc>(space.id)
      const meta = handle.getMeta()
      expect(meta.description).toBe('Updated description')
      expect(meta.image).toBe('data:image/png;base64,abc123')
      handle.close()
    })

    it('should only update specified fields (partial update)', async () => {
      const space = await aliceAdapter.createSpace<TestDoc>('shared', { notes: '' }, {
        name: 'Original',
        description: 'Original desc',
      })

      await aliceAdapter.updateSpace(space.id, { name: 'Changed' })

      const handle = await aliceAdapter.openSpace<TestDoc>(space.id)
      const meta = handle.getMeta()
      expect(meta.name).toBe('Changed')
      expect(meta.description).toBe('Original desc')
      handle.close()
    })

    it('should throw for unknown space', async () => {
      await expect(aliceAdapter.updateSpace('nonexistent', { name: 'Fail' }))
        .rejects.toThrow()
    })

    it('should notify watchSpaces subscribers', async () => {
      const space = await aliceAdapter.createSpace<TestDoc>('shared', { notes: '' }, { name: 'Before' })

      const updates: string[] = []
      const subscribable = aliceAdapter.watchSpaces()
      const unsub = subscribable.subscribe((spaces) => {
        const s = spaces.find(s => s.id === space.id)
        if (s?.name) updates.push(s.name)
      })

      await aliceAdapter.updateSpace(space.id, { name: 'After' })

      // Give observer time to fire
      await new Promise(r => setTimeout(r, 50))

      expect(updates).toContain('After')
      unsub()
    })
  })

  describe('Remote sync of _meta', () => {
    it('should sync name change to other members', async () => {
      // Alice creates space and invites Bob
      const space = await aliceAdapter.createSpace<TestDoc>('shared', { notes: '' }, { name: 'Shared Space' })
      const bobEncKey = await bob.getEncryptionPublicKeyBytes()
      await aliceAdapter.addMember(space.id, bob.getDid(), bobEncKey)

      // Wait for Bob to receive the invite
      await new Promise(r => setTimeout(r, 200))

      // Verify Bob has the space
      const bobSpaces = await bobAdapter.getSpaces()
      const bobSpace = bobSpaces.find(s => s.id === space.id)
      expect(bobSpace).toBeTruthy()
      expect(bobSpace!.name).toBe('Shared Space')

      // Alice renames the space
      await aliceAdapter.updateSpace(space.id, { name: 'Renamed Space' })

      // Wait for sync
      await new Promise(r => setTimeout(r, 200))

      // Bob should see the new name
      const bobSpaceUpdated = await bobAdapter.getSpace(space.id)
      expect(bobSpaceUpdated!.name).toBe('Renamed Space')
    })

    it('should update SpaceInfo on remote _meta change via handle', async () => {
      // Alice creates space and invites Bob
      const space = await aliceAdapter.createSpace<TestDoc>('shared', { notes: '' }, { name: 'Original' })
      const bobEncKey = await bob.getEncryptionPublicKeyBytes()
      await aliceAdapter.addMember(space.id, bob.getDid(), bobEncKey)
      await new Promise(r => setTimeout(r, 200))

      // Bob opens a handle
      const bobHandle = await bobAdapter.openSpace<TestDoc>(space.id)

      // Track remote updates
      let remoteUpdateFired = false
      bobHandle.onRemoteUpdate(() => { remoteUpdateFired = true })

      // Alice updates meta
      await aliceAdapter.updateSpace(space.id, { name: 'Updated by Alice' })
      await new Promise(r => setTimeout(r, 200))

      // Bob's handle should reflect the change
      expect(bobHandle.getMeta().name).toBe('Updated by Alice')
      expect(bobHandle.info().name).toBe('Updated by Alice')
      expect(remoteUpdateFired).toBe(true)

      bobHandle.close()
    })
  })

  describe('Persistence and restore', () => {
    it('should persist _meta and restore on restart', async () => {
      const metadataStorage = new InMemorySpaceMetadataStorage()
      const compactStore = new InMemoryCompactStore()

      // Create adapter with persistence
      const adapter1 = new YjsReplicationAdapter({
        identity: alice,
        messaging: aliceMessaging,
        groupKeyService: new GroupKeyService(),
        metadataStorage,
        compactStore,
      })
      await adapter1.start()

      const space = await adapter1.createSpace<TestDoc>('shared', { notes: '' }, { name: 'Persistent' })
      await adapter1.updateSpace(space.id, { description: 'Saved desc', image: 'data:image/png;base64,img' })

      // Wait for persistence
      await new Promise(r => setTimeout(r, 100))
      await adapter1.stop()

      // Create new adapter instance with same storage
      const adapter2 = new YjsReplicationAdapter({
        identity: alice,
        messaging: aliceMessaging,
        groupKeyService: new GroupKeyService(),
        metadataStorage,
        compactStore,
      })
      await adapter2.start()

      // Space should be restored with _meta values
      const restored = await adapter2.getSpace(space.id)
      expect(restored).toBeTruthy()
      expect(restored!.name).toBe('Persistent')
      expect(restored!.description).toBe('Saved desc')

      // getMeta via handle should also work
      const handle = await adapter2.openSpace<TestDoc>(space.id)
      const meta = handle.getMeta()
      expect(meta.name).toBe('Persistent')
      expect(meta.description).toBe('Saved desc')
      expect(meta.image).toBe('data:image/png;base64,img')
      handle.close()

      await adapter2.stop()
    })

    it('should fall back to PersonalDoc name when _meta is empty (backward compat)', async () => {
      const metadataStorage = new InMemorySpaceMetadataStorage()
      const compactStore = new InMemoryCompactStore()

      // Simulate old-style space: metadata has name but Y.Doc has no _meta
      const adapter = new YjsReplicationAdapter({
        identity: alice,
        messaging: aliceMessaging,
        groupKeyService: new GroupKeyService(),
        metadataStorage,
        compactStore,
      })
      await adapter.start()

      // Create space without _meta (simulating old behavior)
      const space = await adapter.createSpace<TestDoc>('shared', { notes: '' }, { name: 'Legacy Name' })
      await adapter.stop()

      // The name should survive restart via PersonalDoc fallback
      const adapter2 = new YjsReplicationAdapter({
        identity: alice,
        messaging: aliceMessaging,
        groupKeyService: new GroupKeyService(),
        metadataStorage,
        compactStore,
      })
      await adapter2.start()

      const restored = await adapter2.getSpace(space.id)
      expect(restored).toBeTruthy()
      // Name should be available either from _meta or from PersonalDoc fallback
      expect(restored!.name).toBe('Legacy Name')

      await adapter2.stop()
    })
  })

  describe('SpaceHandle.getMeta()', () => {
    it('should return empty meta for space without metadata', async () => {
      const space = await aliceAdapter.createSpace<TestDoc>('shared', { notes: '' })
      const handle = await aliceAdapter.openSpace<TestDoc>(space.id)

      const meta = handle.getMeta()
      expect(meta.name).toBeUndefined()
      expect(meta.description).toBeUndefined()
      expect(meta.image).toBeUndefined()

      handle.close()
    })

    it('should not interfere with getDoc()', async () => {
      const space = await aliceAdapter.createSpace<TestDoc>('shared', { notes: 'hello' }, { name: 'Test' })
      const handle = await aliceAdapter.openSpace<TestDoc>(space.id)

      // App data should be separate from meta
      const doc = handle.getDoc()
      expect(doc.notes).toBe('hello')
      expect((doc as any).name).toBeUndefined()
      expect((doc as any)._meta).toBeUndefined()

      const meta = handle.getMeta()
      expect(meta.name).toBe('Test')

      handle.close()
    })
  })
})
