import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { WotIdentity } from '@web_of_trust/core/application'
import { InMemoryMessagingAdapter, InMemorySpaceMetadataStorage, InMemoryCompactStore } from '@web_of_trust/core/adapters'
import { GroupKeyService } from '@web_of_trust/core/services'
import { AutomergeReplicationAdapter } from '../src/AutomergeReplicationAdapter'
import { InMemoryRepoStorageAdapter } from '../src/InMemoryRepoStorageAdapter'

// Simple doc schema for testing
interface TestDoc {
  counter: number
  items: string[]
}

function createAdapter(identity: WotIdentity, messaging: InMemoryMessagingAdapter) {
  return new AutomergeReplicationAdapter({
    identity,
    messaging,
    groupKeyService: new GroupKeyService(),
  })
}

describe('AutomergeReplicationAdapter', () => {
  let alice: WotIdentity
  let bob: WotIdentity
  let aliceMessaging: InMemoryMessagingAdapter
  let bobMessaging: InMemoryMessagingAdapter
  let aliceAdapter: AutomergeReplicationAdapter
  let bobAdapter: AutomergeReplicationAdapter

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

  describe('Space Lifecycle', () => {
    it('should create a space with an Automerge doc', async () => {
      const space = await aliceAdapter.createSpace<TestDoc>('shared', {
        counter: 0,
        items: [],
      })

      expect(space.id).toBeTruthy()
      expect(space.type).toBe('shared')
      expect(space.members).toContain(alice.getDid())
      expect(space.createdAt).toBeTruthy()
    })

    it('should list created spaces', async () => {
      await aliceAdapter.createSpace<TestDoc>('shared', { counter: 0, items: [] })
      await aliceAdapter.createSpace<TestDoc>('personal', { counter: 0, items: [] })

      const spaces = await aliceAdapter.getSpaces()
      expect(spaces.length).toBe(2)
      expect(spaces.map(s => s.type)).toContain('shared')
      expect(spaces.map(s => s.type)).toContain('personal')
    })

    it('should get a specific space', async () => {
      const created = await aliceAdapter.createSpace<TestDoc>('shared', {
        counter: 0,
        items: [],
      })
      const retrieved = await aliceAdapter.getSpace(created.id)
      expect(retrieved).not.toBeNull()
      expect(retrieved!.id).toBe(created.id)
    })

    it('should return null for unknown space', async () => {
      const result = await aliceAdapter.getSpace('nonexistent')
      expect(result).toBeNull()
    })
  })

  describe('SpaceHandle + Transact', () => {
    it('should open a handle and read initial state', async () => {
      const space = await aliceAdapter.createSpace<TestDoc>('shared', {
        counter: 42,
        items: ['hello'],
      })

      const handle = await aliceAdapter.openSpace<TestDoc>(space.id)
      const doc = handle.getDoc()

      expect(doc.counter).toBe(42)
      expect(doc.items).toEqual(['hello'])

      handle.close()
    })

    it('should transact and update the doc', async () => {
      const space = await aliceAdapter.createSpace<TestDoc>('shared', {
        counter: 0,
        items: [],
      })

      const handle = await aliceAdapter.openSpace<TestDoc>(space.id)
      handle.transact(doc => {
        doc.counter = 10
        doc.items.push('test')
      })

      const doc = handle.getDoc()
      expect(doc.counter).toBe(10)
      expect(doc.items).toEqual(['test'])

      handle.close()
    })

    it('should produce encrypted changes on transact', async () => {
      const space = await aliceAdapter.createSpace<TestDoc>('shared', {
        counter: 0,
        items: [],
      })

      // Add Bob as member first
      const bobEncPub = await bob.getEncryptionPublicKeyBytes()
      await aliceAdapter.addMember(space.id, bob.getDid(), bobEncPub)

      // Wait for invite to be fully processed by Bob
      await new Promise(r => setTimeout(r, 50))

      // Collect messages sent to Bob from now on
      const sentMessages: any[] = []
      bobMessaging.onMessage(env => sentMessages.push(env))

      const handle = await aliceAdapter.openSpace<TestDoc>(space.id)

      handle.transact(doc => {
        doc.counter = 99
      })

      // Wait for automerge-repo async sync via NetworkAdapter
      await new Promise(r => setTimeout(r, 200))

      // automerge-repo sends sync messages via our NetworkAdapter
      // These should be encrypted content messages
      const contentMessages = sentMessages.filter(m => m.type === 'content')
      expect(contentMessages.length).toBeGreaterThan(0)
      const payload = JSON.parse(contentMessages[0].payload)
      expect(payload.spaceId).toBeTruthy()
      expect(payload.generation).toBeTypeOf('number')
      expect(payload.ciphertext).toBeTruthy()

      handle.close()
    })
  })

  describe('Space Invite + Sync', () => {
    it('should send encrypted group key to new member via space-invite', async () => {
      const space = await aliceAdapter.createSpace<TestDoc>('shared', {
        counter: 0,
        items: [],
      })

      const inviteMessages: any[] = []
      bobMessaging.onMessage(env => inviteMessages.push(env))

      const bobEncPub = await bob.getEncryptionPublicKeyBytes()
      await aliceAdapter.addMember(space.id, bob.getDid(), bobEncPub)

      await new Promise(r => setTimeout(r, 10))

      const invite = inviteMessages.find(m => m.type === 'space-invite')
      expect(invite).toBeTruthy()
      expect(invite.toDid).toBe(bob.getDid())
      expect(invite.fromDid).toBe(alice.getDid())

      // Invite should contain documentUrl for automerge-repo sync
      const payload = JSON.parse(invite.payload)
      expect(payload.documentUrl).toBeTruthy()
      expect(payload.documentUrl).toMatch(/^automerge:/)
    })

    it('should allow Bob to join a space after receiving invite', async () => {
      const space = await aliceAdapter.createSpace<TestDoc>('shared', {
        counter: 0,
        items: [],
      })

      const bobEncPub = await bob.getEncryptionPublicKeyBytes()
      await aliceAdapter.addMember(space.id, bob.getDid(), bobEncPub)

      // Wait for invite to arrive
      await new Promise(r => setTimeout(r, 50))

      // Bob should have the space now
      const bobSpace = await bobAdapter.getSpace(space.id)
      expect(bobSpace).not.toBeNull()
      expect(bobSpace!.members).toContain(bob.getDid())
    })

    it('should sync changes from Alice to Bob', async () => {
      const space = await aliceAdapter.createSpace<TestDoc>('shared', {
        counter: 0,
        items: [],
      })

      // Add Bob
      const bobEncPub = await bob.getEncryptionPublicKeyBytes()
      await aliceAdapter.addMember(space.id, bob.getDid(), bobEncPub)
      await new Promise(r => setTimeout(r, 50))

      // Alice makes a change
      const aliceHandle = await aliceAdapter.openSpace<TestDoc>(space.id)
      aliceHandle.transact(doc => {
        doc.counter = 42
        doc.items.push('from-alice')
      })

      // Wait for encrypted change to propagate
      await new Promise(r => setTimeout(r, 500))

      // Bob should see the change
      const bobHandle = await bobAdapter.openSpace<TestDoc>(space.id)
      const bobDoc = bobHandle.getDoc()
      expect(bobDoc.counter).toBe(42)
      expect(bobDoc.items).toContain('from-alice')

      aliceHandle.close()
      bobHandle.close()
    })

    it('should sync bidirectionally (Alice <-> Bob)', async () => {
      const space = await aliceAdapter.createSpace<TestDoc>('shared', {
        counter: 0,
        items: [],
      })

      const bobEncPub = await bob.getEncryptionPublicKeyBytes()
      await aliceAdapter.addMember(space.id, bob.getDid(), bobEncPub)
      await new Promise(r => setTimeout(r, 500))

      // Alice changes
      const aliceHandle = await aliceAdapter.openSpace<TestDoc>(space.id)
      aliceHandle.transact(doc => {
        doc.items.push('alice-item')
      })
      await new Promise(r => setTimeout(r, 500))

      // Bob changes
      const bobHandle = await bobAdapter.openSpace<TestDoc>(space.id)
      bobHandle.transact(doc => {
        doc.items.push('bob-item')
      })
      await new Promise(r => setTimeout(r, 300))

      // Both should have both items (CRDT merge)
      const aliceDoc = aliceHandle.getDoc()
      const bobDoc = bobHandle.getDoc()

      expect(aliceDoc.items).toContain('alice-item')
      expect(aliceDoc.items).toContain('bob-item')
      expect(bobDoc.items).toContain('alice-item')
      expect(bobDoc.items).toContain('bob-item')

      aliceHandle.close()
      bobHandle.close()
    })
  })

  describe('Key Rotation', () => {
    it('should rotate key when member is removed', async () => {
      const space = await aliceAdapter.createSpace<TestDoc>('shared', {
        counter: 0,
        items: [],
      })

      const bobEncPub = await bob.getEncryptionPublicKeyBytes()
      await aliceAdapter.addMember(space.id, bob.getDid(), bobEncPub)
      await new Promise(r => setTimeout(r, 50))

      // Remove Bob — should trigger key rotation
      await aliceAdapter.removeMember(space.id, bob.getDid())

      // Verify key generation incremented
      const generation = aliceAdapter.getKeyGeneration(space.id)
      expect(generation).toBe(1) // Was 0, now 1
    })

    it('should prevent removed member from decrypting new changes', async () => {
      // Create a third user (Carol) to verify she still gets updates
      const carol = new WotIdentity()
      await carol.create('carol-pass', false)
      const carolMessaging = new InMemoryMessagingAdapter()
      await carolMessaging.connect(carol.getDid())
      const carolAdapter = createAdapter(carol, carolMessaging)
      await carolAdapter.start()

      const space = await aliceAdapter.createSpace<TestDoc>('shared', {
        counter: 0,
        items: [],
      })

      const bobEncPub = await bob.getEncryptionPublicKeyBytes()
      const carolEncPub = await carol.getEncryptionPublicKeyBytes()
      await aliceAdapter.addMember(space.id, bob.getDid(), bobEncPub)
      await aliceAdapter.addMember(space.id, carol.getDid(), carolEncPub)
      await new Promise(r => setTimeout(r, 50))

      // Remove Bob
      await aliceAdapter.removeMember(space.id, bob.getDid())
      await new Promise(r => setTimeout(r, 50))

      // Alice makes a change with the new key
      const aliceHandle = await aliceAdapter.openSpace<TestDoc>(space.id)
      aliceHandle.transact(doc => {
        doc.counter = 999
      })
      await new Promise(r => setTimeout(r, 500))

      // Carol should see the change (she got the rotated key)
      const carolHandle = await carolAdapter.openSpace<TestDoc>(space.id)
      expect(carolHandle.getDoc().counter).toBe(999)

      // Bob should NOT have the new key and cannot decrypt
      // His space should still show the old state
      const bobSpace = await bobAdapter.getSpace(space.id)
      if (bobSpace) {
        const bobHandle = await bobAdapter.openSpace<TestDoc>(space.id)
        expect(bobHandle.getDoc().counter).not.toBe(999)
        bobHandle.close()
      }

      aliceHandle.close()
      carolHandle.close()
      await carolAdapter.stop()
      try { await carol.deleteStoredIdentity() } catch {}
    })

    it('should notify remaining members when a member is removed (member-update)', async () => {
      const carol = new WotIdentity()
      await carol.create('carol-pass', false)
      const carolMessaging = new InMemoryMessagingAdapter()
      await carolMessaging.connect(carol.getDid())
      const carolAdapter = createAdapter(carol, carolMessaging)
      await carolAdapter.start()

      const space = await aliceAdapter.createSpace<TestDoc>('shared', {
        counter: 0,
        items: [],
      })

      const bobEncPub = await bob.getEncryptionPublicKeyBytes()
      const carolEncPub = await carol.getEncryptionPublicKeyBytes()
      await aliceAdapter.addMember(space.id, bob.getDid(), bobEncPub)
      await aliceAdapter.addMember(space.id, carol.getDid(), carolEncPub)
      await new Promise(r => setTimeout(r, 50))

      // Carol's local member list should include Bob
      let carolSpace = await carolAdapter.getSpace(space.id)
      expect(carolSpace!.members).toContain(bob.getDid())

      // Remove Bob — Carol should get member-update
      await aliceAdapter.removeMember(space.id, bob.getDid())
      await new Promise(r => setTimeout(r, 50))

      // Carol's member list should no longer include Bob
      carolSpace = await carolAdapter.getSpace(space.id)
      expect(carolSpace!.members).not.toContain(bob.getDid())
      expect(carolSpace!.members).toContain(carol.getDid())
      expect(carolSpace!.members).toContain(alice.getDid())

      await carolAdapter.stop()
      try { await carol.deleteStoredIdentity() } catch {}
    })
  })

  describe('onRemoteUpdate', () => {
    it('should fire callback when remote changes arrive', async () => {
      const space = await aliceAdapter.createSpace<TestDoc>('shared', {
        counter: 0,
        items: [],
      })

      const bobEncPub = await bob.getEncryptionPublicKeyBytes()
      await aliceAdapter.addMember(space.id, bob.getDid(), bobEncPub)
      await new Promise(r => setTimeout(r, 50))

      const bobHandle = await bobAdapter.openSpace<TestDoc>(space.id)
      let updateFired = false
      bobHandle.onRemoteUpdate(() => {
        updateFired = true
      })

      // Alice makes a change
      const aliceHandle = await aliceAdapter.openSpace<TestDoc>(space.id)
      aliceHandle.transact(doc => {
        doc.counter = 7
      })

      await new Promise(r => setTimeout(r, 200))

      expect(updateFired).toBe(true)

      aliceHandle.close()
      bobHandle.close()
    })
  })

  describe('Adapter State', () => {
    it('should track replication state', async () => {
      expect(aliceAdapter.getState()).toBe('idle')
    })

    it('should stop cleanly', async () => {
      await aliceAdapter.stop()
      expect(aliceAdapter.getState()).toBe('idle')
    })
  })

  describe('Concurrent Edits (CRDT)', () => {
    it('should merge when Alice and Bob edit different fields simultaneously', async () => {
      const space = await aliceAdapter.createSpace<TestDoc>('shared', {
        counter: 0,
        items: [],
      })

      const bobEncPub = await bob.getEncryptionPublicKeyBytes()
      await aliceAdapter.addMember(space.id, bob.getDid(), bobEncPub)
      await new Promise(r => setTimeout(r, 50))

      const aliceHandle = await aliceAdapter.openSpace<TestDoc>(space.id)
      const bobHandle = await bobAdapter.openSpace<TestDoc>(space.id)

      // Both edit simultaneously (different fields)
      aliceHandle.transact(doc => {
        doc.counter = 42
      })
      bobHandle.transact(doc => {
        doc.items.push('bob-was-here')
      })

      // Wait for sync
      await new Promise(r => setTimeout(r, 200))

      // Both should have both changes merged
      const aliceDoc = aliceHandle.getDoc()
      const bobDoc = bobHandle.getDoc()

      expect(aliceDoc.counter).toBe(42)
      expect(aliceDoc.items).toContain('bob-was-here')
      expect(bobDoc.counter).toBe(42)
      expect(bobDoc.items).toContain('bob-was-here')

      aliceHandle.close()
      bobHandle.close()
    })

    it('should resolve conflict when Alice and Bob edit the same field', async () => {
      const space = await aliceAdapter.createSpace<TestDoc>('shared', {
        counter: 0,
        items: [],
      })

      const bobEncPub = await bob.getEncryptionPublicKeyBytes()
      await aliceAdapter.addMember(space.id, bob.getDid(), bobEncPub)
      await new Promise(r => setTimeout(r, 50))

      const aliceHandle = await aliceAdapter.openSpace<TestDoc>(space.id)
      const bobHandle = await bobAdapter.openSpace<TestDoc>(space.id)

      // Both edit the same field simultaneously
      aliceHandle.transact(doc => {
        doc.counter = 100
      })
      bobHandle.transact(doc => {
        doc.counter = 200
      })

      // Wait for sync
      await new Promise(r => setTimeout(r, 200))

      // Both should converge to the same value (Automerge picks a deterministic winner)
      const aliceDoc = aliceHandle.getDoc()
      const bobDoc = bobHandle.getDoc()

      expect(aliceDoc.counter).toBe(bobDoc.counter)
      // The value should be one of the two (Automerge doesn't lose data)
      expect([100, 200]).toContain(aliceDoc.counter)

      aliceHandle.close()
      bobHandle.close()
    })

    it('should merge concurrent list pushes from both sides', async () => {
      const space = await aliceAdapter.createSpace<TestDoc>('shared', {
        counter: 0,
        items: [],
      })

      const bobEncPub = await bob.getEncryptionPublicKeyBytes()
      await aliceAdapter.addMember(space.id, bob.getDid(), bobEncPub)
      await new Promise(r => setTimeout(r, 50))

      const aliceHandle = await aliceAdapter.openSpace<TestDoc>(space.id)
      const bobHandle = await bobAdapter.openSpace<TestDoc>(space.id)

      // Both push to the same list simultaneously
      aliceHandle.transact(doc => {
        doc.items.push('alice-1')
        doc.items.push('alice-2')
      })
      bobHandle.transact(doc => {
        doc.items.push('bob-1')
        doc.items.push('bob-2')
      })

      await new Promise(r => setTimeout(r, 200))

      const aliceDoc = aliceHandle.getDoc()
      const bobDoc = bobHandle.getDoc()

      // Both should have all 4 items (order may vary)
      expect(aliceDoc.items).toHaveLength(4)
      expect(aliceDoc.items).toContain('alice-1')
      expect(aliceDoc.items).toContain('alice-2')
      expect(aliceDoc.items).toContain('bob-1')
      expect(aliceDoc.items).toContain('bob-2')

      // Both converge to same state
      expect(aliceDoc.items).toEqual(bobDoc.items)

      aliceHandle.close()
      bobHandle.close()
    })
  })

  describe('Three-Way Sync', () => {
    it('should sync Alice changes to both Bob and Carol', async () => {
      const carol = new WotIdentity()
      await carol.create('carol-pass', false)
      const carolMessaging = new InMemoryMessagingAdapter()
      await carolMessaging.connect(carol.getDid())
      const carolAdapter = createAdapter(carol, carolMessaging)
      await carolAdapter.start()

      const space = await aliceAdapter.createSpace<TestDoc>('shared', {
        counter: 0,
        items: [],
      })

      const bobEncPub = await bob.getEncryptionPublicKeyBytes()
      const carolEncPub = await carol.getEncryptionPublicKeyBytes()
      await aliceAdapter.addMember(space.id, bob.getDid(), bobEncPub)
      await aliceAdapter.addMember(space.id, carol.getDid(), carolEncPub)
      await new Promise(r => setTimeout(r, 500))

      // Open handles first so they're ready to receive sync messages
      const aliceHandle = await aliceAdapter.openSpace<TestDoc>(space.id)
      const bobHandle = await bobAdapter.openSpace<TestDoc>(space.id)
      const carolHandle = await carolAdapter.openSpace<TestDoc>(space.id)

      // Alice writes — should reach both Bob and Carol
      aliceHandle.transact(doc => {
        doc.items.push('from-alice')
      })
      await new Promise(r => setTimeout(r, 300))

      expect(bobHandle.getDoc().items).toContain('from-alice')
      expect(carolHandle.getDoc().items).toContain('from-alice')

      aliceHandle.close()
      bobHandle.close()
      carolHandle.close()
      await carolAdapter.stop()
      try { await carol.deleteStoredIdentity() } catch {}
    })

    it('should notify existing members when a new member joins (member-update)', async () => {
      const carol = new WotIdentity()
      await carol.create('carol-pass', false)
      const carolMessaging = new InMemoryMessagingAdapter()
      await carolMessaging.connect(carol.getDid())
      const carolAdapter = createAdapter(carol, carolMessaging)
      await carolAdapter.start()

      const space = await aliceAdapter.createSpace<TestDoc>('shared', {
        counter: 0,
        items: [],
      })

      // Bob is invited first
      const bobEncPub = await bob.getEncryptionPublicKeyBytes()
      await aliceAdapter.addMember(space.id, bob.getDid(), bobEncPub)
      await new Promise(r => setTimeout(r, 50))

      // Carol is invited after — Bob receives member-update
      const carolEncPub = await carol.getEncryptionPublicKeyBytes()
      await aliceAdapter.addMember(space.id, carol.getDid(), carolEncPub)
      await new Promise(r => setTimeout(r, 50))

      // Bob writes — he now knows about Carol via member-update
      const bobHandle = await bobAdapter.openSpace<TestDoc>(space.id)
      bobHandle.transact(doc => {
        doc.items.push('from-bob')
      })
      await new Promise(r => setTimeout(r, 200))

      // Alice should receive Bob's change
      const aliceHandle = await aliceAdapter.openSpace<TestDoc>(space.id)
      expect(aliceHandle.getDoc().items).toContain('from-bob')

      // Carol should ALSO receive Bob's change
      const carolHandle = await carolAdapter.openSpace<TestDoc>(space.id)
      expect(carolHandle.getDoc().items).toContain('from-bob')

      aliceHandle.close()
      bobHandle.close()
      carolHandle.close()
      await carolAdapter.stop()
      try { await carol.deleteStoredIdentity() } catch {}
    })
  })

  describe('Multiple Transacts', () => {
    it('should handle rapid sequential transacts', async () => {
      const space = await aliceAdapter.createSpace<TestDoc>('shared', {
        counter: 0,
        items: [],
      })

      const bobEncPub = await bob.getEncryptionPublicKeyBytes()
      await aliceAdapter.addMember(space.id, bob.getDid(), bobEncPub)
      await new Promise(r => setTimeout(r, 50))

      const aliceHandle = await aliceAdapter.openSpace<TestDoc>(space.id)

      // Rapid-fire changes
      for (let i = 0; i < 10; i++) {
        aliceHandle.transact(doc => {
          doc.counter = i
          doc.items.push(`item-${i}`)
        })
      }

      await new Promise(r => setTimeout(r, 300))

      // Alice should have final state
      const aliceDoc = aliceHandle.getDoc()
      expect(aliceDoc.counter).toBe(9)
      expect(aliceDoc.items).toHaveLength(10)

      // Bob should have synced all changes
      const bobHandle = await bobAdapter.openSpace<TestDoc>(space.id)
      const bobDoc = bobHandle.getDoc()
      expect(bobDoc.counter).toBe(9)
      expect(bobDoc.items).toHaveLength(10)

      aliceHandle.close()
      bobHandle.close()
    })
  })

  describe('Error Cases', () => {
    it('should throw when transacting on a closed handle', async () => {
      const space = await aliceAdapter.createSpace<TestDoc>('shared', {
        counter: 0,
        items: [],
      })

      const handle = await aliceAdapter.openSpace<TestDoc>(space.id)
      handle.close()

      expect(() => {
        handle.transact(doc => { doc.counter = 1 })
      }).toThrow('Handle is closed')
    })

    it('should throw when opening an unknown space', async () => {
      await expect(
        aliceAdapter.openSpace<TestDoc>('nonexistent')
      ).rejects.toThrow('Unknown space')
    })
  })

  describe('Multiple Spaces', () => {
    it('should handle a user in multiple spaces independently', async () => {
      const space1 = await aliceAdapter.createSpace<TestDoc>('shared', {
        counter: 0,
        items: [],
      })
      const space2 = await aliceAdapter.createSpace<TestDoc>('shared', {
        counter: 100,
        items: ['initial'],
      })

      const bobEncPub = await bob.getEncryptionPublicKeyBytes()
      await aliceAdapter.addMember(space1.id, bob.getDid(), bobEncPub)
      await aliceAdapter.addMember(space2.id, bob.getDid(), bobEncPub)
      await new Promise(r => setTimeout(r, 50))

      // Edit space1
      const handle1 = await aliceAdapter.openSpace<TestDoc>(space1.id)
      handle1.transact(doc => {
        doc.counter = 1
      })

      // Edit space2
      const handle2 = await aliceAdapter.openSpace<TestDoc>(space2.id)
      handle2.transact(doc => {
        doc.counter = 200
      })

      await new Promise(r => setTimeout(r, 200))

      // Bob should see independent states
      const bobHandle1 = await bobAdapter.openSpace<TestDoc>(space1.id)
      const bobHandle2 = await bobAdapter.openSpace<TestDoc>(space2.id)

      expect(bobHandle1.getDoc().counter).toBe(1)
      expect(bobHandle1.getDoc().items).toEqual([])

      expect(bobHandle2.getDoc().counter).toBe(200)
      expect(bobHandle2.getDoc().items).toEqual(['initial'])

      handle1.close()
      handle2.close()
      bobHandle1.close()
      bobHandle2.close()
    })
  })

  describe('Persistence', () => {
    it('should persist and restore space metadata across restarts', async () => {
      const metadataStorage = new InMemorySpaceMetadataStorage()
      const repoStorage = new InMemoryRepoStorageAdapter()
      const groupKeyService = new GroupKeyService()

      // Create adapter with storage
      const adapter1 = new AutomergeReplicationAdapter({
        identity: alice,
        messaging: aliceMessaging,
        groupKeyService,
        metadataStorage,
        repoStorage,
      })
      await adapter1.start()

      // Create a space and make changes
      const space = await adapter1.createSpace<TestDoc>('shared', {
        counter: 0,
        items: [],
      }, { name: 'Test Space', description: 'A test' })

      const handle = await adapter1.openSpace<TestDoc>(space.id)
      handle.transact(doc => {
        doc.counter = 42
        doc.items.push('persisted')
      })

      // Wait for persist
      await new Promise(r => setTimeout(r, 50))

      handle.close()
      await adapter1.stop()

      // Create a NEW adapter with the same storages (simulates restart)
      const groupKeyService2 = new GroupKeyService()
      const adapter2 = new AutomergeReplicationAdapter({
        identity: alice,
        messaging: aliceMessaging,
        groupKeyService: groupKeyService2,
        metadataStorage,
        repoStorage,
      })
      await adapter2.start()

      // Space metadata should be restored
      const restoredSpace = await adapter2.getSpace(space.id)
      expect(restoredSpace).not.toBeNull()
      expect(restoredSpace!.name).toBe('Test Space')
      expect(restoredSpace!.description).toBe('A test')

      // Doc state should be restored (via automerge-repo's own storage)
      const restoredHandle = await adapter2.openSpace<TestDoc>(space.id)
      const doc = restoredHandle.getDoc()
      expect(doc.counter).toBe(42)
      expect(doc.items).toEqual(['persisted'])

      // Group key should be restored
      expect(adapter2.getKeyGeneration(space.id)).toBe(0)

      restoredHandle.close()
      await adapter2.stop()
    })

    it('should persist group key rotations across restarts', async () => {
      const metadataStorage = new InMemorySpaceMetadataStorage()
      const repoStorage = new InMemoryRepoStorageAdapter()
      const groupKeyService = new GroupKeyService()

      const adapter1 = new AutomergeReplicationAdapter({
        identity: alice,
        messaging: aliceMessaging,
        groupKeyService,
        metadataStorage,
        repoStorage,
      })
      await adapter1.start()

      const space = await adapter1.createSpace<TestDoc>('shared', {
        counter: 0,
        items: [],
      })

      // Add and remove Bob to trigger key rotation
      const bobEncPub = await bob.getEncryptionPublicKeyBytes()
      await adapter1.addMember(space.id, bob.getDid(), bobEncPub)
      await new Promise(r => setTimeout(r, 50))
      await adapter1.removeMember(space.id, bob.getDid())
      await new Promise(r => setTimeout(r, 50))

      expect(adapter1.getKeyGeneration(space.id)).toBe(1)

      await adapter1.stop()

      // Restart with new adapter
      const groupKeyService2 = new GroupKeyService()
      const adapter2 = new AutomergeReplicationAdapter({
        identity: alice,
        messaging: aliceMessaging,
        groupKeyService: groupKeyService2,
        metadataStorage,
        repoStorage,
      })
      await adapter2.start()

      // Key generation should be restored
      expect(adapter2.getKeyGeneration(space.id)).toBe(1)

      await adapter2.stop()
    })
  })

  describe('CompactStore Persistence', () => {
    it('should save snapshot to CompactStore on transact', async () => {
      const metadataStorage = new InMemorySpaceMetadataStorage()
      const compactStore = new InMemoryCompactStore()
      const groupKeyService = new GroupKeyService()

      const adapter = new AutomergeReplicationAdapter({
        identity: alice,
        messaging: aliceMessaging,
        groupKeyService,
        metadataStorage,
        compactStore,
      })
      await adapter.start()

      const space = await adapter.createSpace<TestDoc>('shared', {
        counter: 0,
        items: [],
      })

      const handle = await adapter.openSpace<TestDoc>(space.id)
      handle.transact(doc => {
        doc.counter = 42
        doc.items.push('compact-test')
      })

      // Wait for immediate CompactStore push
      await new Promise(r => setTimeout(r, 200))

      // CompactStore should have a snapshot for this space
      expect(compactStore.has(space.id)).toBe(true)
      expect(compactStore.size(space.id)).toBeGreaterThan(0)

      handle.close()
      await adapter.stop()
    })

    it('should restore space from CompactStore on restart (before vault)', async () => {
      const metadataStorage = new InMemorySpaceMetadataStorage()
      const compactStore = new InMemoryCompactStore()
      const groupKeyService = new GroupKeyService()

      // Create adapter and space
      const adapter1 = new AutomergeReplicationAdapter({
        identity: alice,
        messaging: aliceMessaging,
        groupKeyService,
        metadataStorage,
        compactStore,
      })
      await adapter1.start()

      const space = await adapter1.createSpace<TestDoc>('shared', {
        counter: 99,
        items: ['from-compact'],
      }, { name: 'Compact Space' })

      const handle = await adapter1.openSpace<TestDoc>(space.id)
      handle.transact(doc => {
        doc.counter = 123
      })

      // Wait for CompactStore save
      await new Promise(r => setTimeout(r, 200))
      expect(compactStore.has(space.id)).toBe(true)

      handle.close()
      await adapter1.stop()

      // Restart with same compactStore + metadata (no repoStorage!)
      const groupKeyService2 = new GroupKeyService()
      const adapter2 = new AutomergeReplicationAdapter({
        identity: alice,
        messaging: aliceMessaging,
        groupKeyService: groupKeyService2,
        metadataStorage,
        compactStore,
      })
      await adapter2.start()

      // Space should be restored from CompactStore
      const restoredSpace = await adapter2.getSpace(space.id)
      expect(restoredSpace).not.toBeNull()
      expect(restoredSpace!.name).toBe('Compact Space')

      const restoredHandle = await adapter2.openSpace<TestDoc>(space.id)
      const doc = restoredHandle.getDoc()
      expect(doc.counter).toBe(123)
      expect(doc.items).toContain('from-compact')

      restoredHandle.close()
      await adapter2.stop()
    })

    it('should use history-free compaction for CompactStore snapshots', async () => {
      const metadataStorage = new InMemorySpaceMetadataStorage()
      const compactStore = new InMemoryCompactStore()
      const groupKeyService = new GroupKeyService()

      const adapter = new AutomergeReplicationAdapter({
        identity: alice,
        messaging: aliceMessaging,
        groupKeyService,
        metadataStorage,
        compactStore,
      })
      await adapter.start()

      const space = await adapter.createSpace<TestDoc>('shared', {
        counter: 0,
        items: [],
      })

      const handle = await adapter.openSpace<TestDoc>(space.id)

      // Make many changes to accumulate history
      for (let i = 0; i < 20; i++) {
        handle.transact(doc => {
          doc.counter = i
          doc.items.push(`item-${i}`)
        })
      }

      // Wait for CompactStore save
      await new Promise(r => setTimeout(r, 500))

      const snapshotSize = compactStore.size(space.id)

      // Make 20 more changes
      for (let i = 20; i < 40; i++) {
        handle.transact(doc => {
          doc.counter = i
          doc.items.push(`item-${i}`)
        })
      }

      await new Promise(r => setTimeout(r, 500))

      const snapshotSize2 = compactStore.size(space.id)

      // With history-free compaction, size should grow roughly linearly
      // with data, NOT exponentially with change count.
      // The key test: snapshot size should be MUCH smaller than a full
      // Automerge.save() with history would be. With 40 transact() calls,
      // history-based save would be significantly larger.
      // Snapshot with compaction should stay under 1KB for this simple data.
      expect(snapshotSize2).toBeLessThan(1024)
      // And it should grow roughly proportionally (not exponentially)
      expect(snapshotSize2).toBeLessThan(snapshotSize * 5)

      handle.close()
      await adapter.stop()
    })

    it('should debounce CompactStore saves on remote changes', async () => {
      const metadataStorage = new InMemorySpaceMetadataStorage()
      const compactStore = new InMemoryCompactStore()
      const groupKeyService = new GroupKeyService()

      const adapter = new AutomergeReplicationAdapter({
        identity: alice,
        messaging: aliceMessaging,
        groupKeyService,
        metadataStorage,
        compactStore,
      })
      await adapter.start()

      const space = await adapter.createSpace<TestDoc>('shared', {
        counter: 0,
        items: [],
      })

      // Add Bob so we can test remote changes
      const bobEncPub = await bob.getEncryptionPublicKeyBytes()
      await adapter.addMember(space.id, bob.getDid(), bobEncPub)
      await new Promise(r => setTimeout(r, 50))

      // Open handle on Alice's side
      const aliceHandle = await adapter.openSpace<TestDoc>(space.id)

      // Bob makes a change (arrives as remote change on Alice's adapter)
      const bobHandle = await bobAdapter.openSpace<TestDoc>(space.id)
      bobHandle.transact(doc => {
        doc.counter = 777
      })

      // Wait for sync + debounced CompactStore save (2s debounce)
      await new Promise(r => setTimeout(r, 3000))

      // Alice's CompactStore should have the merged state
      expect(compactStore.has(space.id)).toBe(true)

      aliceHandle.close()
      bobHandle.close()
      await adapter.stop()
    }, 10_000)
  })

  describe('onMemberChange', () => {
    it('should fire callback when a member is added', async () => {
      const space = await aliceAdapter.createSpace<TestDoc>('shared', {
        counter: 0,
        items: [],
      })

      let changeFired = false
      aliceAdapter.onMemberChange(() => { changeFired = true })

      const bobEncPub = await bob.getEncryptionPublicKeyBytes()
      await aliceAdapter.addMember(space.id, bob.getDid(), bobEncPub)

      expect(changeFired).toBe(true)
    })

    it('should fire callback when a space invite is received', async () => {
      const space = await aliceAdapter.createSpace<TestDoc>('shared', {
        counter: 0,
        items: [],
      })

      let changeFired = false
      bobAdapter.onMemberChange(() => { changeFired = true })

      const bobEncPub = await bob.getEncryptionPublicKeyBytes()
      await aliceAdapter.addMember(space.id, bob.getDid(), bobEncPub)

      await new Promise(r => setTimeout(r, 50))
      expect(changeFired).toBe(true)
    })
  })
})
