/**
 * VE-4/VE-5/VE-7 (Slice 1.B.3-sync-recovery, Step 3): Aufloesung von Pending-
 * member-updates gegen die kanonische Mitgliederliste + Removal-Cleanup.
 *
 * Sync 005 Z.194-198 (MUSS): "Nach dem naechsten Space-Sync MUSS der Client
 * Pending-Updates gegen die kanonische Mitgliederliste aufloesen" —
 * confirmed (Z.196-197), discarded bei Widerspruch (Z.198).
 *
 * Sync 005 Z.253 Weg (a): eigene Entfernung erst nach kanonischer Bestaetigung
 * als dauerhafter lokaler Austritt (Cleanup ueber die leaveSpace-Mechanik).
 * Sync 005 Z.191: vorher KEIN Cleanup, retrybare Outbox-Eintraege bleiben.
 */
import { describe, it, expect, afterEach, vi } from 'vitest'
import * as Y from 'yjs'
import type { PublicIdentitySession } from '../../wot-core/src/application/identity'
import { createTestIdentity } from '../../wot-core/tests/helpers/identity-session'
import {
  InMemoryMessagingAdapter,
  InMemorySpaceMetadataStorage,
  InMemoryCompactStore,
  InMemoryKeyManagementAdapter,
  InMemoryMemberUpdatePendingStore,
  InMemoryOutboxStore,
  OutboxMessagingAdapter,
} from '@web_of_trust/core/adapters'
import { MEMBER_UPDATE_MESSAGE_TYPE, formatMembershipEventKey } from '@web_of_trust/core/protocol'
import type { MembershipEvent } from '@web_of_trust/core/protocol'
import type { MessagingAdapter, WireMessage } from '@web_of_trust/core/ports'
import { YjsReplicationAdapter } from '../src/YjsReplicationAdapter'

const ADMIN = 'did:key:z6MkAdminAdminAdmin'
const TARGET = 'did:key:z6MkTargetTargetTarget'

const wait = (ms = 100) => new Promise((r) => setTimeout(r, ms))

interface TestDoc { items: Record<string, { title: string }> }

function spaceState(adapter: YjsReplicationAdapter, spaceId: string): any {
  return (adapter as unknown as { spaces: Map<string, any> }).spaces.get(spaceId)
}

function memberUpdateDecoded(senderDid: string, body: Record<string, unknown>) {
  return {
    type: MEMBER_UPDATE_MESSAGE_TYPE,
    senderDid,
    body,
    outerId: crypto.randomUUID(),
    extensionFields: {},
  }
}

/** Seedet createdBy (Admin-Approximation, VE-2) + active@0-Events ins _members-Event-Set. */
function seedMembership(adapter: YjsReplicationAdapter, spaceId: string, creatorDid: string, memberDids: string[]): void {
  const doc: Y.Doc = spaceState(adapter, spaceId).doc
  doc.transact(() => {
    doc.getMap('_meta').set('createdBy', creatorDid)
    const members = doc.getMap<MembershipEvent>('_members')
    for (const did of memberDids) {
      const event: MembershipEvent = { did, status: 'active', sinceGeneration: 0 }
      members.set(formatMembershipEventKey(event), event)
    }
  }, 'local')
}

/** Simuliert eine via CRDT-Merge ANKOMMENDE kanonische Aenderung (origin 'remote'). */
function applyRemoteMembershipEvent(adapter: YjsReplicationAdapter, spaceId: string, event: MembershipEvent): void {
  const doc: Y.Doc = spaceState(adapter, spaceId).doc
  doc.transact(() => {
    doc.getMap<MembershipEvent>('_members').set(formatMembershipEventKey(event), event)
  }, 'remote')
}

interface Harness {
  adapter: YjsReplicationAdapter
  alice: PublicIdentitySession
  messaging: InMemoryMessagingAdapter
  metadata: InMemorySpaceMetadataStorage
  keyManagement: InMemoryKeyManagementAdapter
  compactStore: InMemoryCompactStore
  memberUpdateStore: InMemoryMemberUpdatePendingStore
}

const cleanups: Array<() => Promise<void>> = []

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup()
  InMemoryMessagingAdapter.resetAll()
})

async function setup(options?: {
  passphrase?: string
  memberUpdateStore?: InMemoryMemberUpdatePendingStore
  messagingOverride?: MessagingAdapter
}): Promise<Harness> {
  const alice = (await createTestIdentity(options?.passphrase ?? 'res-alice')).identity
  const messaging = new InMemoryMessagingAdapter()
  await messaging.connect(alice.getDid())
  const metadata = new InMemorySpaceMetadataStorage()
  const keyManagement = new InMemoryKeyManagementAdapter()
  const compactStore = new InMemoryCompactStore()
  const memberUpdateStore = options?.memberUpdateStore ?? new InMemoryMemberUpdatePendingStore()
  const adapter = new YjsReplicationAdapter({
    identity: alice,
    messaging: options?.messagingOverride ?? messaging,
    keyManagement,
    metadataStorage: metadata,
    compactStore,
    memberUpdateStore,
  })
  await adapter.start()
  cleanups.push(async () => {
    await adapter.stop()
    try { await alice.deleteStoredIdentity() } catch {}
  })
  return { adapter, alice, messaging, metadata, keyManagement, compactStore, memberUpdateStore }
}

describe('Pflicht-Test 4 — kanonische Bestaetigung add (Sync 005 Z.196)', () => {
  it('member-update added (pending, eigene DID) → kanonisches active-Event kommt via CRDT → confirmed, resolvePending aufgeraeumt, pendingAddition-Flag weg', async () => {
    const h = await setup()
    const space = await h.adapter.createSpace<TestDoc>('shared', { items: {} }, { name: 'S' })
    seedMembership(h.adapter, space.id, ADMIN, [ADMIN])
    await wait()

    // Admin-signiertes added fuer die eigene DID → pendingAddition-Flag +
    // Pending-Record; die Aufloesung passiert erst beim naechsten Space-Sync.
    const decoded = memberUpdateDecoded(ADMIN, { spaceId: space.id, action: 'added', memberDid: h.alice.getDid(), effectiveKeyGeneration: 0 })
    await (h.adapter as any).handleMemberUpdate(decoded)
    expect(spaceState(h.adapter, space.id).pendingAddition).toEqual({ effectiveKeyGeneration: 0 })
    expect(await h.memberUpdateStore.listSeenForSpace(space.id)).toHaveLength(1)

    // Kanonische Aenderung trifft via CRDT ein → Observer → Resolution:
    // action=added und die kanonische Liste enthaelt alice → confirmed.
    applyRemoteMembershipEvent(h.adapter, space.id, { did: TARGET, status: 'active', sinceGeneration: 0 })
    await wait()

    expect(await h.memberUpdateStore.listSeenForSpace(space.id)).toHaveLength(0)
    expect(spaceState(h.adapter, space.id).pendingAddition).toBeUndefined()
    // Bestaetigung ist KEIN Cleanup-Anlass fuer added — Space bleibt.
    expect(spaceState(h.adapter, space.id)).toBeDefined()
  })
})

describe('Pflicht-Test 5 — kanonische Bestaetigung removed, Fremd-DID (Sync 005 Z.197)', () => {
  it('removed-Pending fuer Fremd-DID → kanonisches removed-Event → confirmed; Projektion info.members aktualisiert; kein Cleanup', async () => {
    const h = await setup()
    const space = await h.adapter.createSpace<TestDoc>('shared', { items: {} }, { name: 'S' })
    seedMembership(h.adapter, space.id, ADMIN, [ADMIN, TARGET])
    await wait()
    expect(spaceState(h.adapter, space.id).info.members).toContain(TARGET)

    const decoded = memberUpdateDecoded(ADMIN, { spaceId: space.id, action: 'removed', memberDid: TARGET, effectiveKeyGeneration: 1 })
    await (h.adapter as any).handleMemberUpdate(decoded)
    expect(await h.memberUpdateStore.listSeenForSpace(space.id)).toHaveLength(1)

    // Kanonische Entfernung (removed@1 gewinnt gegen active@0, Sync 005 Z.305).
    applyRemoteMembershipEvent(h.adapter, space.id, { did: TARGET, status: 'removed', sinceGeneration: 1 })
    await wait()

    expect(spaceState(h.adapter, space.id).info.members).not.toContain(TARGET)
    expect(await h.memberUpdateStore.listSeenForSpace(space.id)).toHaveLength(0)
    // Fremd-Entfernung loest KEIN lokales Cleanup aus.
    expect(spaceState(h.adapter, space.id)).toBeDefined()
    expect(await h.metadata.loadAllSpaceMetadata()).toHaveLength(1)
  })
})

describe('Pflicht-Test 6 — Widerspruch (Sync 005 Z.198)', () => {
  it('removed-Pending fuer eigene DID, kanonische Liste enthaelt sie weiterhin (hoehere sinceGeneration active) → discarded, kein Cleanup, Flag zurueckgesetzt', async () => {
    const h = await setup()
    const space = await h.adapter.createSpace<TestDoc>('shared', { items: {} }, { name: 'S' })
    seedMembership(h.adapter, space.id, ADMIN, [ADMIN])
    await wait()

    const decoded = memberUpdateDecoded(ADMIN, { spaceId: space.id, action: 'removed', memberDid: h.alice.getDid(), effectiveKeyGeneration: 1 })
    await (h.adapter as any).handleMemberUpdate(decoded)
    expect(spaceState(h.adapter, space.id).pendingRemoval).toEqual({ effectiveKeyGeneration: 1 })

    // Kanonischer Widerspruch: alice bleibt aktiv mit HOEHERER sinceGeneration
    // (active@2 gewinnt) → das Pending MUSS verworfen werden (Z.198), der
    // kanonische Membership-State bleibt.
    applyRemoteMembershipEvent(h.adapter, space.id, { did: h.alice.getDid(), status: 'active', sinceGeneration: 2 })
    await wait()

    expect(await h.memberUpdateStore.listSeenForSpace(space.id)).toHaveLength(0)
    expect(spaceState(h.adapter, space.id).pendingRemoval).toBeUndefined()
    // KEIN Cleanup: Space, Doc und Metadata bleiben.
    expect(spaceState(h.adapter, space.id)).toBeDefined()
    expect(spaceState(h.adapter, space.id).info.members).toContain(h.alice.getDid())
    expect(await h.metadata.loadAllSpaceMetadata()).toHaveLength(1)
  })
})

describe('Pflicht-Tests 7 + 12 — localRemovalConfirmed → Cleanup; K3-Erhalt (Sync 005 Z.191/Z.253)', () => {
  it('VORHER (K3, Test 12): member-update removed fuer eigene DID OHNE kanonische Bestaetigung → kein doc.destroy/spaces.delete/deleteSpaceMetadata; NACHHER (Test 7): kanonische Bestaetigung → leaveSpace-Mechanik (Doc weg, Metadata weg, GroupKeys weg)', async () => {
    const h = await setup()
    const space = await h.adapter.createSpace<TestDoc>('shared', { items: {} }, { name: 'S' })
    seedMembership(h.adapter, space.id, ADMIN, [ADMIN])
    await wait()
    const deleteMetadataSpy = vi.spyOn(h.metadata, 'deleteSpaceMetadata')
    const deleteGroupKeysSpy = vi.spyOn(h.metadata, 'deleteGroupKeys')
    const docDestroySpy = vi.spyOn(spaceState(h.adapter, space.id).doc, 'destroy')

    // member-update allein (Sync 005 Z.191): Pending-Flag, KEIN Cleanup.
    const decoded = memberUpdateDecoded(ADMIN, { spaceId: space.id, action: 'removed', memberDid: h.alice.getDid(), effectiveKeyGeneration: 1 })
    await (h.adapter as any).handleMemberUpdate(decoded)
    await wait()
    expect(spaceState(h.adapter, space.id).pendingRemoval).toEqual({ effectiveKeyGeneration: 1 })
    expect(docDestroySpy).not.toHaveBeenCalled()
    expect(deleteMetadataSpy).not.toHaveBeenCalled()
    expect(spaceState(h.adapter, space.id)).toBeDefined()

    // Resolution-Kontrast: die kanonische Mitgliederliste bestaetigt die
    // Entfernung (removed@1 → Projektion ohne alice) → Cleanup via
    // leaveSpace-Mechanik, AUSSCHLIESSLICH aus dem Resolution-Pfad.
    applyRemoteMembershipEvent(h.adapter, space.id, { did: h.alice.getDid(), status: 'removed', sinceGeneration: 1 })
    await wait(200)

    expect(docDestroySpy).toHaveBeenCalled()
    expect(deleteMetadataSpy).toHaveBeenCalledWith(space.id)
    expect(deleteGroupKeysSpy).toHaveBeenCalledWith(space.id)
    expect(spaceState(h.adapter, space.id)).toBeUndefined()
    expect(await h.adapter.getSpace(space.id)).toBeNull()
    expect(await h.metadata.loadAllSpaceMetadata()).toHaveLength(0)
    expect(await h.metadata.loadGroupKeys(space.id)).toHaveLength(0)
  })
})

describe('Pflicht-Tests 7 (Outbox-VORHER) + 13 — VE-5: Cleanup fasst die Outbox nicht an (Sync 005 Z.191)', () => {
  it('Outbox-Eintraege bleiben vor UND nach dem Resolution-Cleanup erhalten; flushOutbox terminiert via maxRetries-Drop (CHECK-0-Befund)', async () => {
    // Innerer Transport, dessen send fehlschlaegt — Outbox-Eintraege sind
    // dadurch unzustellbar und altern ueber retryCount.
    const failingInner: MessagingAdapter = {
      connect: async () => {},
      disconnect: async () => {},
      getState: () => 'connected',
      onStateChange: () => () => {},
      send: async () => { throw new Error('transport down') },
      onMessage: () => () => {},
      onReceipt: () => () => {},
      registerTransport: async () => {},
      resolveTransport: async () => null,
    }
    const outboxStore = new InMemoryOutboxStore()
    const outboxMessaging = new OutboxMessagingAdapter(failingInner, outboxStore, {
      maxRetries: 2,
      sendTimeoutMs: 0,
      reconnectIntervalMs: 0,
    })
    const h = await setup({ passphrase: 'res-outbox', messagingOverride: outboxMessaging })
    const space = await h.adapter.createSpace<TestDoc>('shared', { items: {} }, { name: 'S' })
    seedMembership(h.adapter, space.id, ADMIN, [ADMIN])
    await wait()

    // Nicht-klassifizierbarer Outbox-Eintrag (Befund 13: spaceId nur im
    // verschluesselten Payload — keine zuverlaessige Space-Zuordnung moeglich).
    const queued: WireMessage = {
      v: 1, id: crypto.randomUUID(), type: 'content',
      fromDid: h.alice.getDid(), toDid: ADMIN,
      createdAt: new Date().toISOString(), encoding: 'json',
      payload: JSON.stringify({ spaceId: space.id, generation: 0, ciphertext: [1], nonce: [2] }),
      signature: '',
    } as WireMessage
    await outboxStore.enqueue(queued)
    expect(await outboxStore.has(queued.id)).toBe(true)

    // VORHER-Teil (Pflicht-Test 7, Z.191): nur Pending, keine Bestaetigung →
    // kein Cleanup, der Outbox-Eintrag bleibt.
    await (h.adapter as any).handleMemberUpdate(
      memberUpdateDecoded(ADMIN, { spaceId: space.id, action: 'removed', memberDid: h.alice.getDid(), effectiveKeyGeneration: 1 }))
    await wait()
    expect(spaceState(h.adapter, space.id)).toBeDefined()
    expect(await outboxStore.has(queued.id)).toBe(true)

    // Kanonische Bestaetigung → Cleanup. Die Outbox wird dabei NICHT angefasst.
    applyRemoteMembershipEvent(h.adapter, space.id, { did: h.alice.getDid(), status: 'removed', sinceGeneration: 1 })
    await wait(200)
    expect(spaceState(h.adapter, space.id)).toBeUndefined()
    expect(await outboxStore.has(queued.id)).toBe(true)

    // Terminierung (CHECK 0): Fehlversuche inkrementieren retryCount, nach
    // maxRetries droppt flushOutbox den Eintrag (dequeue + warn) — kein
    // Endlos-Retry.
    await outboxMessaging.flushOutbox() // retryCount 0 → 1
    await outboxMessaging.flushOutbox() // retryCount 1 → 2
    expect(await outboxStore.has(queued.id)).toBe(true)
    await outboxMessaging.flushOutbox() // retryCount 2 >= maxRetries → Drop
    expect(await outboxStore.has(queued.id)).toBe(false)
    expect(await outboxStore.count()).toBe(0)
  })
})

describe('Pflicht-Test 11 — VE-7 Re-Derivation der Pending-Flags beim Restore (Sync 005 Z.253 App-Start)', () => {
  it('mit injiziertem durablem Store: Pending-Flag nach Adapter-Neustart re-deriviert + Catch-up getriggert', async () => {
    // Der Test injiziert denselben Store in beide Adapter-Inkarnationen —
    // er modelliert damit einen durablen Store (die produktive durable
    // Verdrahtung ist bewusst 1.D-Scope).
    const durableStore = new InMemoryMemberUpdatePendingStore()
    const alice = (await createTestIdentity('res-rederive')).identity
    const messaging = new InMemoryMessagingAdapter()
    await messaging.connect(alice.getDid())
    const metadata = new InMemorySpaceMetadataStorage()
    const compactStore = new InMemoryCompactStore()

    const adapter1 = new YjsReplicationAdapter({
      identity: alice, messaging, keyManagement: new InMemoryKeyManagementAdapter(),
      metadataStorage: metadata, compactStore, memberUpdateStore: durableStore,
    })
    await adapter1.start()
    const space = await adapter1.createSpace<TestDoc>('shared', { items: {} }, { name: 'S' })
    seedMembership(adapter1, space.id, ADMIN, [ADMIN])
    await wait()
    await (adapter1 as any).handleMemberUpdate(
      memberUpdateDecoded(ADMIN, { spaceId: space.id, action: 'removed', memberDid: alice.getDid(), effectiveKeyGeneration: 0 }))
    expect(spaceState(adapter1, space.id).pendingRemoval).toEqual({ effectiveKeyGeneration: 0 })
    await adapter1.stop()

    const adapter2 = new YjsReplicationAdapter({
      identity: alice, messaging, keyManagement: new InMemoryKeyManagementAdapter(),
      metadataStorage: metadata, compactStore, memberUpdateStore: durableStore,
    })
    const catchUpSpy = vi.spyOn(adapter2 as any, 'requestSync')
    await adapter2.start()
    cleanups.push(async () => {
      await adapter2.stop()
      try { await alice.deleteStoredIdentity() } catch {}
    })

    // Flag aus listSeenForSpace re-deriviert (hoechste effectiveKeyGeneration).
    expect(spaceState(adapter2, space.id).pendingRemoval).toEqual({ effectiveKeyGeneration: 0 })
    // Z.253: "bei App-Start oder Reconnect MUSS der Client den
    // Bestaetigungs-Sync erneut versuchen" → Catch-up fuer den Pending-Space.
    expect(catchUpSpy).toHaveBeenCalledWith(space.id)
  })

  it('ehrliche Grenze: mit dem Default-InMemory-Store ist das member-update-Pending nach dem Neustart weg (durable Verdrahtung folgt in 1.D)', async () => {
    const alice = (await createTestIdentity('res-volatile')).identity
    const messaging = new InMemoryMessagingAdapter()
    await messaging.connect(alice.getDid())
    const metadata = new InMemorySpaceMetadataStorage()
    const compactStore = new InMemoryCompactStore()

    // KEIN memberUpdateStore injiziert → Default InMemory pro Instanz.
    const adapter1 = new YjsReplicationAdapter({
      identity: alice, messaging, keyManagement: new InMemoryKeyManagementAdapter(),
      metadataStorage: metadata, compactStore,
    })
    await adapter1.start()
    const space = await adapter1.createSpace<TestDoc>('shared', { items: {} }, { name: 'S' })
    seedMembership(adapter1, space.id, ADMIN, [ADMIN])
    await wait()
    await (adapter1 as any).handleMemberUpdate(
      memberUpdateDecoded(ADMIN, { spaceId: space.id, action: 'removed', memberDid: alice.getDid(), effectiveKeyGeneration: 0 }))
    expect(spaceState(adapter1, space.id).pendingRemoval).toBeDefined()
    await adapter1.stop()

    const adapter2 = new YjsReplicationAdapter({
      identity: alice, messaging, keyManagement: new InMemoryKeyManagementAdapter(),
      metadataStorage: metadata, compactStore,
    })
    await adapter2.start()
    cleanups.push(async () => {
      await adapter2.stop()
      try { await alice.deleteStoredIdentity() } catch {}
    })

    // Sync 002 Z.171 (Pending-Zustaende MUESSEN Neustarts ueberleben) ist fuer
    // member-update-Pendings mit dem Default-Store NICHT erfuellt — der
    // Re-Derivation-Mechanismus ist korrekt, sein Default-Store ist fluechtig.
    expect(spaceState(adapter2, space.id)).toBeDefined()
    expect(spaceState(adapter2, space.id).pendingRemoval).toBeUndefined()
  })
})
