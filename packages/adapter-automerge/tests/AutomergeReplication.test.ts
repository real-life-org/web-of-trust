import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as Automerge from '@automerge/automerge'
import type { PublicIdentitySession } from '../../wot-core/src/application/identity'
import { createTestIdentity } from '../../wot-core/tests/helpers/identity-session'
import { InMemoryMessagingAdapter, InProcessLogBroker, InMemorySpaceMetadataStorage, InMemoryCompactStore, InMemoryKeyManagementAdapter } from '@web_of_trust/core/adapters'
import {
  isDidcommMessage, assertEncryptedInboxEnvelope, SPACE_INVITE_MESSAGE_TYPE, MEMBER_UPDATE_MESSAGE_TYPE,
  LOG_ENTRY_MESSAGE_TYPE, parseLogEntryMessage, verifyLogEntryJws,
} from '@web_of_trust/core/protocol'
import type { SpaceHandle } from '@web_of_trust/core/ports'
import type { SpaceInfo } from '@web_of_trust/core/types'
import { AutomergeReplicationAdapter } from '../src/AutomergeReplicationAdapter'
import { InMemoryRepoStorageAdapter } from '../src/InMemoryRepoStorageAdapter'
import { logSyncOptions } from './helpers/log-sync'
import { WebCryptoProtocolCryptoAdapter } from '@web_of_trust/core/protocol-adapters'

// Die Handler nehmen das DEKODIERTE Inbox-Ergebnis (receiveInboxMessage accept):
// senderDid ist der verifizierte Inner-JWS-Signer (S1), der Klartext-Body kommt
// aus dem Inner-JWS-Payload.
function memberUpdateDecoded(senderDid: string, body: Record<string, unknown>) {
  return {
    type: MEMBER_UPDATE_MESSAGE_TYPE,
    senderDid,
    body,
    outerId: crypto.randomUUID(),
    extensionFields: {},
  }
}

// Simple doc schema for testing
interface TestDoc {
  counter: number
  items: string[]
}

/*
 * Event-driven waits. Replication and invite acceptance are asynchronous
 * (transact() is fire-and-forget: each change is encrypted, signed and
 * delivered as its own log entry), so a test awaits the event that proves the
 * state, never a time window. Each wait is bounded only by the test timeout;
 * a missing event fails the test instead of letting it read a stale state.
 */

/**
 * Resolves once `adapter`'s space list satisfies `predicate` (watchSpaces).
 */
function spacesReach(adapter: AutomergeReplicationAdapter, predicate: (spaces: SpaceInfo[]) => boolean): Promise<void> {
  return new Promise((resolve) => {
    let done = false
    const unsubscribe = adapter.watchSpaces().subscribe((spaces) => {
      if (!done && predicate(spaces)) { done = true; unsubscribe(); resolve() }
    })
    if (!done && predicate(adapter.watchSpaces().getValue())) { done = true; unsubscribe(); resolve() }
  })
}

/**
 * Resolves once `adapter` knows `spaceId` (the space-invite was accepted).
 */
function spaceKnown(adapter: AutomergeReplicationAdapter, spaceId: string): Promise<void> {
  return spacesReach(adapter, (spaces) => spaces.some((s) => s.id === spaceId))
}

/**
 * Resolves once `adapter`'s view of `spaceId` lists `memberDid` as a member
 * (invite accepted, or member-update / membership sync applied).
 */
function spaceHasMember(adapter: AutomergeReplicationAdapter, spaceId: string, memberDid: string): Promise<void> {
  return spacesReach(adapter, (spaces) => spaces.some((s) => s.id === spaceId && s.members.includes(memberDid)))
}

/**
 * Resolves once the doc behind `handle` satisfies `predicate`. Replication via
 * the log path is eventual (transact() is fire-and-forget: each change is
 * encrypted, signed and delivered asynchronously), so a remote peer's state is
 * awaited on its remote-update events, never on a time window. Bounded only by
 * the test timeout.
 */
function docReaches<T>(handle: SpaceHandle<T>, predicate: (doc: T) => boolean): Promise<void> {
  return new Promise((resolve) => {
    let done = false
    const unsubscribe = handle.onRemoteUpdate(() => {
      if (!done && predicate(handle.getDoc())) { done = true; unsubscribe(); resolve() }
    })
    if (!done && predicate(handle.getDoc())) { done = true; unsubscribe(); resolve() }
  })
}

/**
 * Resolves once all handles hold the same Automerge heads, i.e. every peer has
 * applied every other peer's changes (CRDT convergence). Rechecked on each
 * remote update of any handle.
 */
function docsConverge(handles: SpaceHandle<unknown>[]): Promise<void> {
  const heads = (handle: SpaceHandle<unknown>) =>
    Automerge.getHeads(handle.getDoc() as Automerge.Doc<unknown>).slice().sort().join(',')
  return new Promise((resolve) => {
    let done = false
    const unsubscribes: Array<() => void> = []
    const check = () => {
      if (done) return
      const first = heads(handles[0])
      if (handles.every((handle) => heads(handle) === first)) {
        done = true
        for (const unsubscribe of unsubscribes) unsubscribe()
        resolve()
      }
    }
    for (const handle of handles) unsubscribes.push(handle.onRemoteUpdate(check))
    check()
  })
}

/**
 * Resolves with the first message `messaging` delivers that satisfies
 * `predicate`. Subscribe BEFORE triggering the send.
 */
function nextMessage(messaging: InMemoryMessagingAdapter, predicate: (envelope: any) => boolean): Promise<any> {
  return new Promise((resolve) => {
    let done = false
    const unsubscribe = messaging.onMessage((envelope) => {
      if (!done && predicate(envelope)) { done = true; unsubscribe(); resolve(envelope) }
    })
  })
}

/**
 * Resolves once the CompactStore snapshot of `spaceId` satisfies `predicate`
 * (checked now and after every save the adapter performs).
 */
function compactSnapshotReaches<T>(store: InMemoryCompactStore, spaceId: string, predicate: (doc: T) => boolean): Promise<void> {
  const matches = async () => {
    const binary = await store.load(spaceId)
    return binary !== null && predicate(Automerge.load<T>(binary))
  }
  return new Promise((resolve) => {
    const originalSave = store.save.bind(store)
    let done = false
    const finish = () => { done = true; store.save = originalSave; resolve() }
    store.save = async (docId: string, binary: Uint8Array) => {
      await originalSave(docId, binary)
      if (!done && docId === spaceId && await matches()) finish()
    }
    void matches().then((ok) => { if (ok && !done) finish() })
  })
}

/**
 * Writes all pending automerge-repo saves of `spaceId` to the repo storage
 * (automerge-repo throttles saves; Repo.flush is its explicit barrier).
 */
async function flushRepo(adapter: AutomergeReplicationAdapter, spaceId: string): Promise<void> {
  const internal = adapter as unknown as {
    spaces: Map<string, { documentId: string }>
    repo: { flush(documentIds?: string[]): Promise<void> }
  }
  await internal.repo.flush([internal.spaces.get(spaceId)!.documentId])
}

/**
 * Seedet die kanonische Membership ueber den produktiven Pfad (VE-1/VE-2):
 * doc._createdBy + doc._admins[creator] (echte Admin-Liste, 1.B.3-admin-
 * management) + active@0-Events im grow-only doc._members-Event-Set
 * (reservierte Root-Keys, F-6) — die members-/admins-Projektion aktualisiert
 * der Doc-Change-Handler. Der seedende creatorDid ist damit der autoritative
 * Admin (knownAdminDids = spaceAdminDids = resolveActiveAdmins(_admins, _members)).
 */
function seedMembership(adapter: AutomergeReplicationAdapter, spaceId: string, creatorDid: string, memberDids: string[]): void {
  const internal = adapter as unknown as {
    spaces: Map<string, { documentId: string }>
    repo: { handles: Record<string, { change(fn: (d: any) => void): void }> }
  }
  const state = internal.spaces.get(spaceId)!
  internal.repo.handles[state.documentId].change((d: any) => {
    d._createdBy = creatorDid
    if (!d._members) d._members = {}
    for (const did of memberDids) {
      d._members[`${did}:0:active`] = { did, status: 'active', sinceGeneration: 0 }
    }
    if (!d._admins) d._admins = {}
    d._admins[creatorDid] = { did: creatorDid }
  })
}

// wot#386: all peers of a test share one broker and run the log-sync path — the
// only replication path the relay accepts.
let broker = new InProcessLogBroker()

async function brokerMessaging(did: string): Promise<InMemoryMessagingAdapter> {
  const messaging = new InMemoryMessagingAdapter({ broker, socketId: crypto.randomUUID() })
  await messaging.connect(did)
  return messaging
}

async function createAdapter(identity: PublicIdentitySession, messaging: InMemoryMessagingAdapter) {
  return new AutomergeReplicationAdapter({
    identity,
    messaging,
    ...(await logSyncOptions(crypto.randomUUID())),
    brokerUrls: ['wss://broker.example.com'],
    keyManagement: new InMemoryKeyManagementAdapter(),
  })
}

describe('AutomergeReplicationAdapter', () => {
  let alice: PublicIdentitySession
  let bob: PublicIdentitySession
  let aliceMessaging: InMemoryMessagingAdapter
  let bobMessaging: InMemoryMessagingAdapter
  let aliceAdapter: AutomergeReplicationAdapter
  let bobAdapter: AutomergeReplicationAdapter

  beforeEach(async () => {
    InMemoryMessagingAdapter.resetAll()
    broker = new InProcessLogBroker()

    alice = (await createTestIdentity('alice-pass')).identity
    bob = (await createTestIdentity('bob-pass')).identity

    aliceMessaging = await brokerMessaging(alice.getDid())
    bobMessaging = await brokerMessaging(bob.getDid())

    aliceAdapter = await createAdapter(alice, aliceMessaging)
    bobAdapter = await createAdapter(bob, bobMessaging)

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
      const bobJoined = spaceKnown(bobAdapter, space.id)
      await aliceAdapter.addMember(space.id, bob.getDid(), bobEncPub)
      await bobJoined

      // Collect messages sent to Bob from now on
      const sentMessages: any[] = []
      bobMessaging.onMessage(env => sentMessages.push(env))

      const handle = await aliceAdapter.openSpace<TestDoc>(space.id)
      const bobHandle = await bobAdapter.openSpace<TestDoc>(space.id)

      const logEntryArrived = nextMessage(bobMessaging, m => isDidcommMessage(m) && m.type === LOG_ENTRY_MESSAGE_TYPE)

      handle.transact(doc => {
        doc.counter = 99
      })

      // The change's log entry reached Bob, and Bob applied it
      await Promise.all([logEntryArrived, docReaches(bobHandle, doc => doc.counter === 99)])
      bobHandle.close()

      // wot#386: Space-Inhalt reist als vom Autor signierter log-entry (Sync 002),
      // verschluesselt — der Old-World-`content`-Kanal ist am Relay gesperrt.
      const logEntries = sentMessages.filter(m => isDidcommMessage(m) && m.type === LOG_ENTRY_MESSAGE_TYPE)
      expect(logEntries.length).toBeGreaterThan(0)
      for (const msg of logEntries) {
        const payload = await verifyLogEntryJws(parseLogEntryMessage(msg).body.entry, { crypto: new WebCryptoProtocolCryptoAdapter() })
        expect(payload.authorKid.startsWith(`${alice.getDid()}#`)).toBe(true)
        expect(payload.keyGeneration).toBeTypeOf('number')
        expect(JSON.stringify(msg)).not.toContain('"counter"')
      }

      handle.close()
    })
  })

  describe('Space Invite + Sync', () => {
    it('should send encrypted group key to new member via space-invite', async () => {
      const space = await aliceAdapter.createSpace<TestDoc>('shared', {
        counter: 0,
        items: [],
      })

      const inviteArrived = nextMessage(bobMessaging, m => isDidcommMessage(m) && m.type === SPACE_INVITE_MESSAGE_TYPE)

      const bobEncPub = await bob.getEncryptionPublicKeyBytes()
      await aliceAdapter.addMember(space.id, bob.getDid(), bobEncPub)

      // Inbox-Wire-Form (Sync 003): encrypted DIDComm-Envelope, kein Klartext-Body.
      const invite = await inviteArrived
      expect(invite).toBeTruthy()
      expect(invite.to).toEqual([bob.getDid()])
      expect(invite.from).toBe(alice.getDid())
      expect(() => assertEncryptedInboxEnvelope(invite, SPACE_INVITE_MESSAGE_TYPE)).not.toThrow()

      // M2: documentUrl reist NICHT als unauthentifizierte Wire-Extension —
      // sie steckt im Group-Key-verschlüsselten Snapshot-Blob (Sync 005
      // Z.68-90: der signierte Body kennt kein documentUrl-Feld; ein
      // untrusted Broker darf die Doc-Bindung nicht austauschen können).
      expect(invite.body.documentUrl).toBeUndefined()
      expect(JSON.stringify(invite)).not.toContain('automerge:')
      expect(invite.body.encryptedDocSnapshot).toBeTruthy()
    })

    it('M2 PFLICHT: manipulierte documentUrl-Extension auf dem Wire bindet den Empfänger nicht', async () => {
      // Angreifer-Modell: untrusted Broker tauscht beim Store-and-Forward
      // Felder außerhalb des ECIES/Inner-JWS-Pfads aus. Die Doc-Bindung kommt
      // ausschließlich aus dem Group-Key-geschützten Snapshot-Blob.
      const space = await aliceAdapter.createSpace<TestDoc>('shared', { counter: 7, items: [] })
      const decoy = await aliceAdapter.createSpace<TestDoc>('shared', { counter: 0, items: [] })

      // Dave ist nie mit dem Live-Messaging verbunden — der Invite wird
      // abgefangen, manipuliert und direkt in den Empfangspfad gegeben.
      const dave = (await createTestIdentity('dave-pass')).identity
      const daveEncPub = await dave.getEncryptionPublicKeyBytes()

      const sentByAlice: any[] = []
      const originalSend = aliceMessaging.send.bind(aliceMessaging)
      ;(aliceMessaging as any).send = async (message: any) => {
        sentByAlice.push(message)
        return originalSend(message)
      }
      await aliceAdapter.addMember(space.id, dave.getDid(), daveEncPub)
      const invite = sentByAlice.find(m => isDidcommMessage(m) && m.type === SPACE_INVITE_MESSAGE_TYPE)
      expect(invite).toBeTruthy()

      const attackerUrl = (aliceAdapter as any).spaces.get(decoy.id).documentUrl
      const tampered = { ...invite, body: { ...invite.body, documentUrl: attackerUrl } }

      const daveMessaging = new InMemoryMessagingAdapter()
      const daveAdapter = new AutomergeReplicationAdapter({
        identity: dave,
        messaging: daveMessaging,
        brokerUrls: ['wss://broker.example.com'],
        keyManagement: new InMemoryKeyManagementAdapter(),
      })
      await daveAdapter.start()
      await (daveAdapter as any).handleInboxEnvelope(tampered)

      const daveSpace = (daveAdapter as any).spaces.get(space.id)
      expect(daveSpace).toBeDefined()
      // Bindung an die documentId aus dem geschützten Snapshot, NICHT an die Wire-Extension:
      expect(daveSpace.documentId).toBe((aliceAdapter as any).spaces.get(space.id).documentId)
      expect(daveSpace.documentId).not.toBe((aliceAdapter as any).spaces.get(decoy.id).documentId)

      await daveAdapter.stop()
      try { await dave.deleteStoredIdentity() } catch {}
    })

    it('M2: manipulierter encryptedDocSnapshot (GCM) → reject ohne Bindung und ohne Key-State', async () => {
      const space = await aliceAdapter.createSpace<TestDoc>('shared', { counter: 7, items: [] })

      const dave = (await createTestIdentity('dave2-pass')).identity
      const daveEncPub = await dave.getEncryptionPublicKeyBytes()

      const sentByAlice: any[] = []
      const originalSend = aliceMessaging.send.bind(aliceMessaging)
      ;(aliceMessaging as any).send = async (message: any) => {
        sentByAlice.push(message)
        return originalSend(message)
      }
      await aliceAdapter.addMember(space.id, dave.getDid(), daveEncPub)
      const invite = sentByAlice.find(m => isDidcommMessage(m) && m.type === SPACE_INVITE_MESSAGE_TYPE)

      // Flip one bit of the last byte (inside the GCM tag). Overwriting the
      // trailing base64url characters with a fixed value is a no-op whenever
      // the blob already ends in that value (random ciphertext: rare flake).
      const blob: string = invite.body.encryptedDocSnapshot
      const bytes = Buffer.from(blob, 'base64url')
      bytes[bytes.length - 1] ^= 0x01
      const tamperedBlob = bytes.toString('base64url')
      expect(tamperedBlob).not.toBe(blob)
      const tampered = {
        ...invite,
        body: { ...invite.body, encryptedDocSnapshot: tamperedBlob },
      }

      const daveKeyManagement = new InMemoryKeyManagementAdapter()
      const daveMessaging = new InMemoryMessagingAdapter()
      const daveAdapter = new AutomergeReplicationAdapter({
        identity: dave,
        messaging: daveMessaging,
        brokerUrls: ['wss://broker.example.com'],
        keyManagement: daveKeyManagement,
      })
      await daveAdapter.start()
      await (daveAdapter as any).handleInboxEnvelope(tampered)

      // GCM-Auth-Fehler → invalid-rejected VOR applySpaceInviteBody: weder
      // Space-Bindung noch partieller Key-State.
      expect((daveAdapter as any).spaces.get(space.id)).toBeUndefined()
      expect(await daveKeyManagement.getCurrentKey(space.id)).toBeNull()

      await daveAdapter.stop()
      try { await dave.deleteStoredIdentity() } catch {}
    })

    it('should allow Bob to join a space after receiving invite', async () => {
      const space = await aliceAdapter.createSpace<TestDoc>('shared', {
        counter: 0,
        items: [],
      })

      const bobEncPub = await bob.getEncryptionPublicKeyBytes()
      const bobJoined = spaceKnown(bobAdapter, space.id)
      await aliceAdapter.addMember(space.id, bob.getDid(), bobEncPub)
      await bobJoined

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
      const bobJoined = spaceKnown(bobAdapter, space.id)
      await aliceAdapter.addMember(space.id, bob.getDid(), bobEncPub)
      await bobJoined

      // Alice makes a change
      const aliceHandle = await aliceAdapter.openSpace<TestDoc>(space.id)
      const bobHandle = await bobAdapter.openSpace<TestDoc>(space.id)
      aliceHandle.transact(doc => {
        doc.counter = 42
        doc.items.push('from-alice')
      })

      // Bob should see the change
      await docReaches(bobHandle, doc => doc.counter === 42)
      const bobDoc = bobHandle.getDoc()
      expect(bobDoc.counter).toBe(42)
      expect(bobDoc.items).toEqual(['from-alice'])

      aliceHandle.close()
      bobHandle.close()
    })

    it('should sync bidirectionally (Alice <-> Bob)', async () => {
      const space = await aliceAdapter.createSpace<TestDoc>('shared', {
        counter: 0,
        items: [],
      })

      const bobEncPub = await bob.getEncryptionPublicKeyBytes()
      const bobJoined = spaceKnown(bobAdapter, space.id)
      await aliceAdapter.addMember(space.id, bob.getDid(), bobEncPub)
      await bobJoined

      // Alice changes
      const aliceHandle = await aliceAdapter.openSpace<TestDoc>(space.id)
      const bobHandle = await bobAdapter.openSpace<TestDoc>(space.id)
      aliceHandle.transact(doc => {
        doc.items.push('alice-item')
      })
      await docReaches(bobHandle, doc => doc.items.includes('alice-item'))

      // Bob changes (after he has seen Alice's item: causally ordered)
      bobHandle.transact(doc => {
        doc.items.push('bob-item')
      })
      await docReaches(aliceHandle, doc => doc.items.includes('bob-item'))

      // Both should have both items (CRDT merge), in causal order
      const aliceDoc = aliceHandle.getDoc()
      const bobDoc = bobHandle.getDoc()

      expect(aliceDoc.items).toEqual(['alice-item', 'bob-item'])
      expect(bobDoc.items).toEqual(['alice-item', 'bob-item'])

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
      const bobJoined = spaceKnown(bobAdapter, space.id)
      await aliceAdapter.addMember(space.id, bob.getDid(), bobEncPub)
      await bobJoined

      // Remove Bob — should trigger key rotation
      await aliceAdapter.removeMember(space.id, bob.getDid())

      // Verify key generation incremented
      const generation = await aliceAdapter.getKeyGeneration(space.id)
      expect(generation).toBe(1) // Was 0, now 1
    })

    it('should prevent removed member from decrypting new changes', async () => {
      // Create a third user (Carol) to verify she still gets updates
      const carol = (await createTestIdentity('carol-pass')).identity
      const carolMessaging = await brokerMessaging(carol.getDid())
      const carolAdapter = await createAdapter(carol, carolMessaging)
      await carolAdapter.start()

      const space = await aliceAdapter.createSpace<TestDoc>('shared', {
        counter: 0,
        items: [],
      })

      const bobEncPub = await bob.getEncryptionPublicKeyBytes()
      const carolEncPub = await carol.getEncryptionPublicKeyBytes()
      const bobJoined = spaceKnown(bobAdapter, space.id)
      const carolJoined = spaceKnown(carolAdapter, space.id)
      await aliceAdapter.addMember(space.id, bob.getDid(), bobEncPub)
      await aliceAdapter.addMember(space.id, carol.getDid(), carolEncPub)
      // Beide Invites muessen angekommen sein, BEVOR die Rotation laeuft —
      // sonst ginge carols key-rotation an einen unbekannten Space.
      await Promise.all([bobJoined, carolJoined])

      // Remove Bob
      await aliceAdapter.removeMember(space.id, bob.getDid())

      // Alice makes a change with the new key
      const aliceHandle = await aliceAdapter.openSpace<TestDoc>(space.id)
      const carolHandle = await carolAdapter.openSpace<TestDoc>(space.id)
      aliceHandle.transact(doc => {
        doc.counter = 999
      })
      // F-1 (B1): reist die Membership-Change gen-1-gelabelt VOR carols
      // rotation-apply ein, liegt sie im blocked-by-key-Buffer und wird nach
      // dem Apply replayed — carol konvergiert deterministisch (Ereignis
      // statt Zeitfenster, Assertion unveraendert).
      await docReaches(carolHandle, doc => doc.counter === 999)
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

    it('records a pending removal on member-update without mutating canonical state (K3)', async () => {
      // Authority-Split: an admin-signed removal becomes a pending signal; the adapter
      // does NOT mutate the canonical member list (Sync 005 Z.191) — that follows on
      // confirmed Space-Sync (later slice).
      const space = await aliceAdapter.createSpace<TestDoc>('shared', { counter: 0, items: [] })
      const admin = 'did:key:z6MkAdminSignerSigner'
      const target = 'did:key:z6MkTargetTargetTarget'
      const st = (aliceAdapter as unknown as {
        spaces: Map<string, { info: { members: string[] } }>
      }).spaces.get(space.id)!
      // SPEC-APPROX admin = createdBy (VE-2): Seeding ueber den produktiven Pfad —
      // createdBy + active@0-Events im Doc, die Projektion folgt via Handler.
      seedMembership(aliceAdapter, space.id, admin, [admin, target])

      const decoded = memberUpdateDecoded(admin, { spaceId: space.id, action: 'removed', memberDid: target, effectiveKeyGeneration: 0 })
      const outcome = await (aliceAdapter as unknown as { handleMemberUpdate(d: unknown): Promise<unknown> }).handleMemberUpdate(decoded)

      const pending = await (aliceAdapter as unknown as {
        memberUpdateStore: { listSeenForSpace(id: string): Promise<Array<{ action: string; memberDid: string }>> }
      }).memberUpdateStore.listSeenForSpace(space.id)
      expect(pending.some(p => p.action === 'removed' && p.memberDid === target)).toBe(true)
      expect(st.info.members).toContain(target) // durable state survives (Z.191)
      // STOP-10-Mapping: Signal recorded → applied/durable → ack.
      expect(outcome).toEqual({ kind: 'applied', durable: true })
    })

    it('pendingAddition and pendingRemoval are mutually exclusive (member-update)', async () => {
      const space = await aliceAdapter.createSpace<TestDoc>('shared', { counter: 0, items: [] })
      const admin = 'did:key:z6MkAdminSignerSigner'
      const local = alice.getDid()
      const st = (aliceAdapter as unknown as {
        spaces: Map<string, { info: { members: string[] }; pendingAddition?: unknown; pendingRemoval?: unknown }>
      }).spaces.get(space.id)!
      // SPEC-APPROX admin = createdBy (VE-2): Seeding ueber den produktiven Pfad.
      seedMembership(aliceAdapter, space.id, admin, [admin])
      // Generation 1: fuer beide Pendings traegt das Event-Set (alice active@0)
      // noch keine Antwort — die Review-M1-Sofortaufloesung greift nicht, die
      // Flags bleiben als Pending-UX stehen (Sync 005 Z.183-184).
      const mk = (action: 'added' | 'removed') =>
        memberUpdateDecoded(admin, { spaceId: space.id, action, memberDid: local, effectiveKeyGeneration: 1 })
      const call = (d: unknown) => (aliceAdapter as unknown as { handleMemberUpdate(d: unknown): Promise<unknown> }).handleMemberUpdate(d)

      await call(mk('added'))
      expect(st.pendingAddition).toBeDefined()
      await call(mk('removed'))
      expect(st.pendingRemoval).toBeDefined()
      expect(st.pendingAddition).toBeUndefined()
    })
  })

  describe('onRemoteUpdate', () => {
    it('should fire callback when remote changes arrive', async () => {
      const space = await aliceAdapter.createSpace<TestDoc>('shared', {
        counter: 0,
        items: [],
      })

      const bobEncPub = await bob.getEncryptionPublicKeyBytes()
      const bobJoined = spaceKnown(bobAdapter, space.id)
      await aliceAdapter.addMember(space.id, bob.getDid(), bobEncPub)
      await bobJoined

      const bobHandle = await bobAdapter.openSpace<TestDoc>(space.id)
      let updateFired = false
      // The callback IS the event under test: the test waits for it (bounded by
      // the test timeout) and checks it carried Alice's change.
      const fired = new Promise<number>((resolve) => {
        bobHandle.onRemoteUpdate(() => {
          updateFired = true
          resolve(bobHandle.getDoc().counter)
        })
      })

      // Alice makes a change
      const aliceHandle = await aliceAdapter.openSpace<TestDoc>(space.id)
      aliceHandle.transact(doc => {
        doc.counter = 7
      })

      expect(await fired).toBe(7)
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
      const bobJoined = spaceKnown(bobAdapter, space.id)
      await aliceAdapter.addMember(space.id, bob.getDid(), bobEncPub)
      await bobJoined

      const aliceHandle = await aliceAdapter.openSpace<TestDoc>(space.id)
      const bobHandle = await bobAdapter.openSpace<TestDoc>(space.id)

      // Both edit simultaneously (different fields)
      aliceHandle.transact(doc => {
        doc.counter = 42
      })
      bobHandle.transact(doc => {
        doc.items.push('bob-was-here')
      })

      // Wait until both peers applied each other's change
      await docsConverge([aliceHandle, bobHandle])

      // Both should have both changes merged
      const aliceDoc = aliceHandle.getDoc()
      const bobDoc = bobHandle.getDoc()

      expect(aliceDoc.counter).toBe(42)
      expect(aliceDoc.items).toEqual(['bob-was-here'])
      expect(bobDoc.counter).toBe(42)
      expect(bobDoc.items).toEqual(['bob-was-here'])

      aliceHandle.close()
      bobHandle.close()
    })

    it('should resolve conflict when Alice and Bob edit the same field', async () => {
      const space = await aliceAdapter.createSpace<TestDoc>('shared', {
        counter: 0,
        items: [],
      })

      const bobEncPub = await bob.getEncryptionPublicKeyBytes()
      const bobJoined = spaceKnown(bobAdapter, space.id)
      await aliceAdapter.addMember(space.id, bob.getDid(), bobEncPub)
      await bobJoined

      const aliceHandle = await aliceAdapter.openSpace<TestDoc>(space.id)
      const bobHandle = await bobAdapter.openSpace<TestDoc>(space.id)

      // Both edit the same field simultaneously
      aliceHandle.transact(doc => {
        doc.counter = 100
      })
      bobHandle.transact(doc => {
        doc.counter = 200
      })

      // Wait until both peers applied each other's change
      await docsConverge([aliceHandle, bobHandle])

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
      const bobJoined = spaceKnown(bobAdapter, space.id)
      await aliceAdapter.addMember(space.id, bob.getDid(), bobEncPub)
      await bobJoined

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

      // Wait until both peers applied each other's change
      await docsConverge([aliceHandle, bobHandle])

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
      const carol = (await createTestIdentity('carol-pass')).identity
      const carolMessaging = await brokerMessaging(carol.getDid())
      const carolAdapter = await createAdapter(carol, carolMessaging)
      await carolAdapter.start()

      const space = await aliceAdapter.createSpace<TestDoc>('shared', {
        counter: 0,
        items: [],
      })

      const bobEncPub = await bob.getEncryptionPublicKeyBytes()
      const carolEncPub = await carol.getEncryptionPublicKeyBytes()
      const bobJoined = spaceKnown(bobAdapter, space.id)
      const carolJoined = spaceKnown(carolAdapter, space.id)
      await aliceAdapter.addMember(space.id, bob.getDid(), bobEncPub)
      await aliceAdapter.addMember(space.id, carol.getDid(), carolEncPub)
      await Promise.all([bobJoined, carolJoined])

      // Open handles first so they're ready to receive sync messages
      const aliceHandle = await aliceAdapter.openSpace<TestDoc>(space.id)
      const bobHandle = await bobAdapter.openSpace<TestDoc>(space.id)
      const carolHandle = await carolAdapter.openSpace<TestDoc>(space.id)

      // Alice writes — should reach both Bob and Carol
      aliceHandle.transact(doc => {
        doc.items.push('from-alice')
      })
      await Promise.all([
        docReaches(bobHandle, doc => doc.items.includes('from-alice')),
        docReaches(carolHandle, doc => doc.items.includes('from-alice')),
      ])

      expect(bobHandle.getDoc().items).toEqual(['from-alice'])
      expect(carolHandle.getDoc().items).toEqual(['from-alice'])

      aliceHandle.close()
      bobHandle.close()
      carolHandle.close()
      await carolAdapter.stop()
      try { await carol.deleteStoredIdentity() } catch {}
    })

    it('should notify existing members when a new member joins (member-update)', async () => {
      const carol = (await createTestIdentity('carol-pass')).identity
      const carolMessaging = await brokerMessaging(carol.getDid())
      const carolAdapter = await createAdapter(carol, carolMessaging)
      await carolAdapter.start()

      const space = await aliceAdapter.createSpace<TestDoc>('shared', {
        counter: 0,
        items: [],
      })

      // Bob is invited first
      const bobEncPub = await bob.getEncryptionPublicKeyBytes()
      const bobJoined = spaceKnown(bobAdapter, space.id)
      await aliceAdapter.addMember(space.id, bob.getDid(), bobEncPub)
      await bobJoined

      // Carol is invited after — Bob receives member-update
      const carolEncPub = await carol.getEncryptionPublicKeyBytes()
      const carolJoined = spaceKnown(carolAdapter, space.id)
      const bobKnowsCarol = spaceHasMember(bobAdapter, space.id, carol.getDid())
      await aliceAdapter.addMember(space.id, carol.getDid(), carolEncPub)
      await Promise.all([carolJoined, bobKnowsCarol])

      // Bob writes — he now knows about Carol via member-update
      const aliceHandle = await aliceAdapter.openSpace<TestDoc>(space.id)
      const carolHandle = await carolAdapter.openSpace<TestDoc>(space.id)
      const bobHandle = await bobAdapter.openSpace<TestDoc>(space.id)
      bobHandle.transact(doc => {
        doc.items.push('from-bob')
      })

      // Alice and Carol should BOTH receive Bob's change
      await Promise.all([
        docReaches(aliceHandle, doc => doc.items.includes('from-bob')),
        docReaches(carolHandle, doc => doc.items.includes('from-bob')),
      ])
      expect(aliceHandle.getDoc().items).toEqual(['from-bob'])
      expect(carolHandle.getDoc().items).toEqual(['from-bob'])

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
      const bobJoined = spaceKnown(bobAdapter, space.id)
      await aliceAdapter.addMember(space.id, bob.getDid(), bobEncPub)
      await bobJoined

      const aliceHandle = await aliceAdapter.openSpace<TestDoc>(space.id)
      const bobHandle = await bobAdapter.openSpace<TestDoc>(space.id)

      // Rapid-fire changes
      for (let i = 0; i < 10; i++) {
        aliceHandle.transact(doc => {
          doc.counter = i
          doc.items.push(`item-${i}`)
        })
      }

      const expectedItems = Array.from({ length: 10 }, (_, i) => `item-${i}`)

      // transact() applies to the local doc synchronously
      const aliceDoc = aliceHandle.getDoc()
      expect(aliceDoc.counter).toBe(9)
      expect(aliceDoc.items).toEqual(expectedItems)

      // Bob converges to the final state: no change lost, none reordered
      await docReaches(bobHandle, doc => doc.items.length === expectedItems.length)
      const bobDoc = bobHandle.getDoc()
      expect(bobDoc.counter).toBe(9)
      expect(bobDoc.items).toEqual(expectedItems)

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
      const bobJoined = Promise.all([spaceKnown(bobAdapter, space1.id), spaceKnown(bobAdapter, space2.id)])
      await aliceAdapter.addMember(space1.id, bob.getDid(), bobEncPub)
      await aliceAdapter.addMember(space2.id, bob.getDid(), bobEncPub)
      await bobJoined

      const bobHandle1 = await bobAdapter.openSpace<TestDoc>(space1.id)
      const bobHandle2 = await bobAdapter.openSpace<TestDoc>(space2.id)

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

      // Bob should see independent states
      await Promise.all([
        docReaches(bobHandle1, doc => doc.counter === 1),
        docReaches(bobHandle2, doc => doc.counter === 200),
      ])

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
      const keyManagement = new InMemoryKeyManagementAdapter()

      // Create adapter with storage
      const adapter1 = new AutomergeReplicationAdapter({
        brokerUrls: ['wss://broker.example.com'],
        identity: alice,
        messaging: aliceMessaging,
        keyManagement,
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

      // Persist: write automerge-repo's throttled save before the restart
      await flushRepo(adapter1, space.id)

      handle.close()
      await adapter1.stop()

      // Create a NEW adapter with the same storages (simulates restart)
      const keyManagement2 = new InMemoryKeyManagementAdapter()
      const adapter2 = new AutomergeReplicationAdapter({
        brokerUrls: ['wss://broker.example.com'],
        identity: alice,
        messaging: aliceMessaging,
        keyManagement: keyManagement2,
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
      expect(await adapter2.getKeyGeneration(space.id)).toBe(0)

      restoredHandle.close()
      await adapter2.stop()
    })

    it('should persist group key rotations across restarts', async () => {
      const metadataStorage = new InMemorySpaceMetadataStorage()
      const repoStorage = new InMemoryRepoStorageAdapter()
      const keyManagement = new InMemoryKeyManagementAdapter()

      const adapter1 = new AutomergeReplicationAdapter({
        brokerUrls: ['wss://broker.example.com'],
        identity: alice,
        messaging: aliceMessaging,
        keyManagement,
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
      const bobJoined = spaceKnown(bobAdapter, space.id)
      await adapter1.addMember(space.id, bob.getDid(), bobEncPub)
      await bobJoined
      await adapter1.removeMember(space.id, bob.getDid())

      expect(await adapter1.getKeyGeneration(space.id)).toBe(1)

      await adapter1.stop()

      // Restart with new adapter
      const keyManagement2 = new InMemoryKeyManagementAdapter()
      const adapter2 = new AutomergeReplicationAdapter({
        brokerUrls: ['wss://broker.example.com'],
        identity: alice,
        messaging: aliceMessaging,
        keyManagement: keyManagement2,
        metadataStorage,
        repoStorage,
      })
      await adapter2.start()

      // Key generation should be restored
      expect(await adapter2.getKeyGeneration(space.id)).toBe(1)

      await adapter2.stop()
    })
  })

  describe('CompactStore Persistence', () => {
    it('should save snapshot to CompactStore on transact', async () => {
      const metadataStorage = new InMemorySpaceMetadataStorage()
      const compactStore = new InMemoryCompactStore()
      const keyManagement = new InMemoryKeyManagementAdapter()

      const adapter = new AutomergeReplicationAdapter({
        brokerUrls: ['wss://broker.example.com'],
        identity: alice,
        messaging: aliceMessaging,
        keyManagement,
        metadataStorage,
        compactStore,
      })
      await adapter.start()

      const space = await adapter.createSpace<TestDoc>('shared', {
        counter: 0,
        items: [],
      })

      const handle = await adapter.openSpace<TestDoc>(space.id)
      const saved = compactSnapshotReaches<TestDoc>(compactStore, space.id, doc => doc.counter === 42)
      handle.transact(doc => {
        doc.counter = 42
        doc.items.push('compact-test')
      })

      // Wait for the immediate CompactStore push carrying this change
      await saved

      // CompactStore should have a snapshot for this space
      expect(compactStore.has(space.id)).toBe(true)
      expect(compactStore.size(space.id)).toBeGreaterThan(0)

      handle.close()
      await adapter.stop()
    })

    it('should restore space from CompactStore on restart (before vault)', async () => {
      const metadataStorage = new InMemorySpaceMetadataStorage()
      const compactStore = new InMemoryCompactStore()
      const keyManagement = new InMemoryKeyManagementAdapter()

      // Create adapter and space
      const adapter1 = new AutomergeReplicationAdapter({
        brokerUrls: ['wss://broker.example.com'],
        identity: alice,
        messaging: aliceMessaging,
        keyManagement,
        metadataStorage,
        compactStore,
      })
      await adapter1.start()

      const space = await adapter1.createSpace<TestDoc>('shared', {
        counter: 99,
        items: ['from-compact'],
      }, { name: 'Compact Space' })

      const handle = await adapter1.openSpace<TestDoc>(space.id)
      const saved = compactSnapshotReaches<TestDoc>(compactStore, space.id, doc => doc.counter === 123)
      handle.transact(doc => {
        doc.counter = 123
      })

      // Wait for the CompactStore save carrying this change
      await saved
      expect(compactStore.has(space.id)).toBe(true)

      handle.close()
      await adapter1.stop()

      // Restart with same compactStore + metadata (no repoStorage!)
      const keyManagement2 = new InMemoryKeyManagementAdapter()
      const adapter2 = new AutomergeReplicationAdapter({
        brokerUrls: ['wss://broker.example.com'],
        identity: alice,
        messaging: aliceMessaging,
        keyManagement: keyManagement2,
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

    it('uses lineage-preserving compressed snapshots for the CompactStore (Sync 002 Z.158)', async () => {
      // MIGRIERT (F-1-Restart-Befund): die fruehere historienfreie
      // "Kompaktierung" (JSON-Roundtrip + Automerge.from) erzeugte ein NEUES
      // Doc mit frischen Change-Hashes — ein Restore davon konnte keinerlei
      // inkrementelle Changes mehr anwenden (Live-Sync-Catch-up UND
      // blocked-by-key-Replay dependency-tot). Der Snapshot ist jetzt
      // Automerge.save (komprimiert, Lineage erhalten); die Wachstums-
      // Schranke bleibt als Assertion erhalten.
      const metadataStorage = new InMemorySpaceMetadataStorage()
      const compactStore = new InMemoryCompactStore()
      const keyManagement = new InMemoryKeyManagementAdapter()

      const adapter = new AutomergeReplicationAdapter({
        brokerUrls: ['wss://broker.example.com'],
        identity: alice,
        messaging: aliceMessaging,
        keyManagement,
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
      const firstSaved = compactSnapshotReaches<TestDoc>(compactStore, space.id, doc => doc.items.length === 20)
      for (let i = 0; i < 20; i++) {
        handle.transact(doc => {
          doc.counter = i
          doc.items.push(`item-${i}`)
        })
      }

      // Wait for the CompactStore save carrying all 20 changes
      await firstSaved

      const snapshotSize = compactStore.size(space.id)

      // Make 20 more changes
      const secondSaved = compactSnapshotReaches<TestDoc>(compactStore, space.id, doc => doc.items.length === 40)
      for (let i = 20; i < 40; i++) {
        handle.transact(doc => {
          doc.counter = i
          doc.items.push(`item-${i}`)
        })
      }

      await secondSaved

      const snapshotSize2 = compactStore.size(space.id)

      // Wachstum bleibt grob proportional zur Datenmenge (komprimierte
      // Spaltenform), nicht exponentiell zur Change-Zahl.
      expect(snapshotSize2).toBeLessThan(snapshotSize * 5)

      // Lineage-Erhalt: der gespeicherte Snapshot traegt die Change-History —
      // ein historienfrei re-erzeugtes Doc (frueheres Verhalten) haette genau
      // EINE Change mit frischen Hashes; bekannte Ops werden nicht
      // zurueckgerollt (Z.158), ein Restore kann inkrementelle Changes
      // (Live-Sync, blocked-by-key-Replay) weiter anwenden. Die exakte Tiefe
      // haengt vom Push-Zeitpunkt des Schedulers ab (Dirty-Check-Tail) —
      // tragend ist NICHT die Tiefe, sondern dass die Lineage existiert.
      const snapshotBinary = (await compactStore.load(space.id))!
      const restored = Automerge.load<TestDoc>(snapshotBinary)
      expect(Automerge.getAllChanges(restored).length).toBeGreaterThan(1)

      handle.close()
      await adapter.stop()
    })

    it('should debounce CompactStore saves on remote changes', async () => {
      const metadataStorage = new InMemorySpaceMetadataStorage()
      const compactStore = new InMemoryCompactStore()
      const keyManagement = new InMemoryKeyManagementAdapter()

      // wot#386: remote changes travel only on the log-sync path, so this
      // device runs it (own socket on the shared broker, like createAdapter).
      const adapter = new AutomergeReplicationAdapter({
        brokerUrls: ['wss://broker.example.com'],
        identity: alice,
        messaging: await brokerMessaging(alice.getDid()),
        ...(await logSyncOptions(crypto.randomUUID())),
        keyManagement,
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
      const bobJoined = spaceKnown(bobAdapter, space.id)
      await adapter.addMember(space.id, bob.getDid(), bobEncPub)
      await bobJoined

      // Open handle on Alice's side
      const aliceHandle = await adapter.openSpace<TestDoc>(space.id)

      // Bob makes a change (arrives as remote change on Alice's adapter)
      const bobHandle = await bobAdapter.openSpace<TestDoc>(space.id)
      const merged = compactSnapshotReaches<TestDoc>(compactStore, space.id, doc => doc.counter === 777)
      bobHandle.transact(doc => {
        doc.counter = 777
      })

      // Wait for sync + the debounced CompactStore save (2s debounce)
      await docReaches(aliceHandle, doc => doc.counter === 777)
      await merged

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
      const fired = new Promise<void>((resolve) => {
        bobAdapter.onMemberChange(() => { changeFired = true; resolve() })
      })

      const bobEncPub = await bob.getEncryptionPublicKeyBytes()
      await aliceAdapter.addMember(space.id, bob.getDid(), bobEncPub)

      await fired
      expect(changeFired).toBe(true)
    })
  })
})
