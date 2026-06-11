/**
 * VE-4/VE-5/VE-7 (Slice 1.B.3-sync-recovery, Step 5 — Automerge-Mirror):
 * Aufloesung von Pending-member-updates gegen die kanonische Mitgliederliste
 * + Removal-Cleanup.
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
import { MEMBER_UPDATE_MESSAGE_TYPE } from '@web_of_trust/core/protocol'
import type { MembershipEvent } from '@web_of_trust/core/protocol'
import type { MessagingAdapter, WireMessage } from '@web_of_trust/core/ports'
import { AutomergeReplicationAdapter } from '../src/AutomergeReplicationAdapter'

const ADMIN = 'did:key:z6MkAdminAdminAdmin'
const TARGET = 'did:key:z6MkTargetTargetTarget'

const wait = (ms = 150) => new Promise((r) => setTimeout(r, ms))

/**
 * Flake-Haertung (Review-Minor): pollt eine Bedingung statt fix zu schlafen.
 * Loest bei Timeout still auf — die nachfolgenden expects liefern dann die
 * aussagekraeftige Diff.
 */
async function waitUntil(condition: () => boolean | Promise<boolean>, timeoutMs = 4000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await condition()) return
    await new Promise((r) => setTimeout(r, 25))
  }
}

interface TestDoc { items: Record<string, { title: string }> }

function spaceState(adapter: AutomergeReplicationAdapter, spaceId: string): any {
  return (adapter as unknown as { spaces: Map<string, any> }).spaces.get(spaceId)
}

function docHandle(adapter: AutomergeReplicationAdapter, spaceId: string): { change(fn: (d: any) => void): void } {
  const state = spaceState(adapter, spaceId)
  return (adapter as unknown as { repo: { handles: Record<string, { change(fn: (d: any) => void): void }> } }).repo.handles[state.documentId]
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

/** Seedet createdBy (Admin-Approximation, VE-2) + active@0-Events ins doc.members-Event-Set. */
function seedMembership(adapter: AutomergeReplicationAdapter, spaceId: string, creatorDid: string, memberDids: string[]): void {
  docHandle(adapter, spaceId).change((d: any) => {
    d.createdBy = creatorDid
    if (!d.members) d.members = {}
    for (const did of memberDids) {
      d.members[`${did}:0:active`] = { did, status: 'active', sinceGeneration: 0 }
    }
  })
}

/**
 * Simuliert eine ANKOMMENDE kanonische Aenderung. Automerge unterscheidet im
 * change-Event nicht zwischen lokalem und remote Ursprung — der
 * Doc-Change-Handler (Resolution-Trigger) ist origin-agnostisch, genau wie
 * der _members-Observer im Yjs-Adapter.
 */
function applyCanonicalMembershipEvent(adapter: AutomergeReplicationAdapter, spaceId: string, event: MembershipEvent): void {
  docHandle(adapter, spaceId).change((d: any) => {
    if (!d.members) d.members = {}
    d.members[`${event.did}:${event.sinceGeneration}:${event.status}`] = { ...event }
  })
}

interface Harness {
  adapter: AutomergeReplicationAdapter
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
  const alice = (await createTestIdentity(options?.passphrase ?? 'am-res-alice')).identity
  const messaging = new InMemoryMessagingAdapter()
  await messaging.connect(alice.getDid())
  const metadata = new InMemorySpaceMetadataStorage()
  const keyManagement = new InMemoryKeyManagementAdapter()
  const compactStore = new InMemoryCompactStore()
  const memberUpdateStore = options?.memberUpdateStore ?? new InMemoryMemberUpdatePendingStore()
  const adapter = new AutomergeReplicationAdapter({
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
  it('member-update added (pending, eigene DID) → kanonisches active-Event kommt an → confirmed, resolvePending aufgeraeumt, pendingAddition-Flag weg', async () => {
    const h = await setup()
    const space = await h.adapter.createSpace<TestDoc>('shared', { items: {} }, { name: 'S' })
    seedMembership(h.adapter, space.id, ADMIN, [ADMIN])
    await wait()

    // Admin-signiertes added@1 fuer die eigene DID → pendingAddition-Flag +
    // Pending-Record; die Aufloesung passiert erst beim naechsten Space-Sync
    // (Review-M1: das Event-Set traegt fuer Generation 1 noch keine Antwort —
    // alices Gewinner-Event ist active@0 —, also bleibt das Pending offen).
    const decoded = memberUpdateDecoded(ADMIN, { spaceId: space.id, action: 'added', memberDid: h.alice.getDid(), effectiveKeyGeneration: 1 })
    await (h.adapter as any).handleMemberUpdate(decoded)
    expect(spaceState(h.adapter, space.id).pendingAddition).toEqual({ effectiveKeyGeneration: 1 })
    expect(await h.memberUpdateStore.listSeenForSpace(space.id)).toHaveLength(1)

    // Kanonische Aenderung trifft ein → Doc-Change-Handler → Resolution:
    // action=added und die kanonische Liste enthaelt alice → confirmed.
    applyCanonicalMembershipEvent(h.adapter, space.id, { did: TARGET, status: 'active', sinceGeneration: 0 })
    await waitUntil(async () => (await h.memberUpdateStore.listSeenForSpace(space.id)).length === 0)

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
    applyCanonicalMembershipEvent(h.adapter, space.id, { did: TARGET, status: 'removed', sinceGeneration: 1 })
    await waitUntil(async () => (await h.memberUpdateStore.listSeenForSpace(space.id)).length === 0)

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
    applyCanonicalMembershipEvent(h.adapter, space.id, { did: h.alice.getDid(), status: 'active', sinceGeneration: 2 })
    await waitUntil(async () => (await h.memberUpdateStore.listSeenForSpace(space.id)).length === 0)

    expect(await h.memberUpdateStore.listSeenForSpace(space.id)).toHaveLength(0)
    expect(spaceState(h.adapter, space.id).pendingRemoval).toBeUndefined()
    // KEIN Cleanup: Space, Doc und Metadata bleiben.
    expect(spaceState(h.adapter, space.id)).toBeDefined()
    expect(spaceState(h.adapter, space.id).info.members).toContain(h.alice.getDid())
    expect(await h.metadata.loadAllSpaceMetadata()).toHaveLength(1)
  })
})

describe('Pflicht-Tests 7 + 12 — localRemovalConfirmed → Cleanup; K3-Erhalt (Sync 005 Z.191/Z.253)', () => {
  it('VORHER (K3, Test 12): member-update removed fuer eigene DID OHNE kanonische Bestaetigung → kein repo.delete/spaces.delete/deleteSpaceMetadata; NACHHER (Test 7): kanonische Bestaetigung → leaveSpace-Mechanik (Repo-Doc weg, Metadata weg, GroupKeys weg, CompactStore weg)', async () => {
    const h = await setup()
    const space = await h.adapter.createSpace<TestDoc>('shared', { items: {} }, { name: 'S' })
    seedMembership(h.adapter, space.id, ADMIN, [ADMIN])
    // fire-and-forget _saveToCompactStore aus createSpace abwarten
    await waitUntil(() => h.compactStore.has(space.id))
    expect(h.compactStore.has(space.id)).toBe(true)
    const deleteMetadataSpy = vi.spyOn(h.metadata, 'deleteSpaceMetadata')
    const deleteGroupKeysSpy = vi.spyOn(h.metadata, 'deleteGroupKeys')
    const repoDeleteSpy = vi.spyOn((h.adapter as any).repo, 'delete')

    // member-update allein (Sync 005 Z.191): Pending-Flag, KEIN Cleanup.
    const decoded = memberUpdateDecoded(ADMIN, { spaceId: space.id, action: 'removed', memberDid: h.alice.getDid(), effectiveKeyGeneration: 1 })
    await (h.adapter as any).handleMemberUpdate(decoded)
    await wait()
    expect(spaceState(h.adapter, space.id).pendingRemoval).toEqual({ effectiveKeyGeneration: 1 })
    expect(repoDeleteSpy).not.toHaveBeenCalled()
    expect(deleteMetadataSpy).not.toHaveBeenCalled()
    expect(spaceState(h.adapter, space.id)).toBeDefined()

    // Resolution-Kontrast: die kanonische Mitgliederliste bestaetigt die
    // Entfernung (removed@1 → Projektion ohne alice) → Cleanup via
    // leaveSpace-Mechanik, AUSSCHLIESSLICH aus dem Resolution-Pfad.
    const documentId = spaceState(h.adapter, space.id).documentId
    applyCanonicalMembershipEvent(h.adapter, space.id, { did: h.alice.getDid(), status: 'removed', sinceGeneration: 1 })
    await waitUntil(() => spaceState(h.adapter, space.id) === undefined && !h.compactStore.has(space.id))

    expect(repoDeleteSpy).toHaveBeenCalledWith(documentId)
    expect(deleteMetadataSpy).toHaveBeenCalledWith(space.id)
    expect(deleteGroupKeysSpy).toHaveBeenCalledWith(space.id)
    expect(spaceState(h.adapter, space.id)).toBeUndefined()
    expect(await h.adapter.getSpace(space.id)).toBeNull()
    expect(await h.metadata.loadAllSpaceMetadata()).toHaveLength(0)
    expect(await h.metadata.loadGroupKeys(space.id)).toHaveLength(0)
    expect(h.compactStore.has(space.id)).toBe(false)
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
    const h = await setup({ passphrase: 'am-res-outbox', messagingOverride: outboxMessaging })
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
    applyCanonicalMembershipEvent(h.adapter, space.id, { did: h.alice.getDid(), status: 'removed', sinceGeneration: 1 })
    await waitUntil(() => spaceState(h.adapter, space.id) === undefined)
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

describe('Review-M1 — canonical-first: kanonische Bestaetigung VOR dem member-update (Sync 005 Z.194/Z.253)', () => {
  it('(1) removed@N kommt per CRDT zuerst, dann member-update(removed, eigene DID) → Pending wird sofort aufgeloest, Cleanup laeuft (Z.253 Weg a)', async () => {
    const h = await setup({ passphrase: 'am-m1-canonical-first-removed' })
    const space = await h.adapter.createSpace<TestDoc>('shared', { items: {} }, { name: 'S' })
    seedMembership(h.adapter, space.id, ADMIN, [ADMIN])
    await wait()

    // Die kanonische Entfernung reist dem member-update voraus (Z.231-Design:
    // das Doc-Update ist mit dem alten Key entschluesselbar). Der Doc-Change-
    // Handler laeuft hier mit LEERER Pending-Liste — der historische Deadlock.
    applyCanonicalMembershipEvent(h.adapter, space.id, { did: h.alice.getDid(), status: 'removed', sinceGeneration: 1 })
    await waitUntil(() => spaceState(h.adapter, space.id)?.info.members.includes(h.alice.getDid()) === false)
    expect(spaceState(h.adapter, space.id)).toBeDefined() // kein Pending bestaetigt → kein Cleanup
    expect(spaceState(h.adapter, space.id).info.members).not.toContain(h.alice.getDid())

    // Jetzt erst das member-update: das Event-Set traegt die Antwort bereits →
    // sofortige Aufloesung nach savePending, ohne weitere kanonische Aenderung.
    await (h.adapter as any).handleMemberUpdate(
      memberUpdateDecoded(ADMIN, { spaceId: space.id, action: 'removed', memberDid: h.alice.getDid(), effectiveKeyGeneration: 1 }))

    expect(await h.memberUpdateStore.listSeenForSpace(space.id)).toHaveLength(0)
    expect(spaceState(h.adapter, space.id)).toBeUndefined()
    expect(await h.adapter.getSpace(space.id)).toBeNull()
    expect(await h.metadata.loadAllSpaceMetadata()).toHaveLength(0)
    expect(await h.metadata.loadGroupKeys(space.id)).toHaveLength(0)
  })

  it('(2) canonical-first add fuer Fremd-DID → sofort confirmed, Pending weg, kein Cleanup', async () => {
    const h = await setup({ passphrase: 'am-m1-canonical-first-added' })
    const space = await h.adapter.createSpace<TestDoc>('shared', { items: {} }, { name: 'S' })
    seedMembership(h.adapter, space.id, ADMIN, [ADMIN])
    await wait()

    // Kanonisches active@1 fuer TARGET kommt zuerst.
    applyCanonicalMembershipEvent(h.adapter, space.id, { did: TARGET, status: 'active', sinceGeneration: 1 })
    await waitUntil(() => spaceState(h.adapter, space.id)?.info.members.includes(TARGET) === true)
    expect(spaceState(h.adapter, space.id).info.members).toContain(TARGET)

    await (h.adapter as any).handleMemberUpdate(
      memberUpdateDecoded(ADMIN, { spaceId: space.id, action: 'added', memberDid: TARGET, effectiveKeyGeneration: 1 }))

    // Sofort confirmed (Z.196) — kein Flag (Fremd-DID), kein Cleanup.
    expect(await h.memberUpdateStore.listSeenForSpace(space.id)).toHaveLength(0)
    expect(spaceState(h.adapter, space.id)).toBeDefined()
    expect(spaceState(h.adapter, space.id).pendingAddition).toBeUndefined()
    expect(spaceState(h.adapter, space.id).pendingRemoval).toBeUndefined()
    expect(await h.metadata.loadAllSpaceMetadata()).toHaveLength(1)
  })

  it('(4) Idempotenz: feuert der Doc-Change-Handler nach der savePending-Resolution erneut → kein Doppel-Cleanup, kein Fehler', async () => {
    const h = await setup({ passphrase: 'am-m1-idempotenz' })
    const space = await h.adapter.createSpace<TestDoc>('shared', { items: {} }, { name: 'S' })
    seedMembership(h.adapter, space.id, ADMIN, [ADMIN])
    await wait()

    applyCanonicalMembershipEvent(h.adapter, space.id, { did: h.alice.getDid(), status: 'removed', sinceGeneration: 1 })
    await waitUntil(() => spaceState(h.adapter, space.id)?.info.members.includes(h.alice.getDid()) === false)
    const spaceRef = spaceState(h.adapter, space.id)
    const members = spaceRef.info.members
    const repoDeleteSpy = vi.spyOn((h.adapter as any).repo, 'delete')
    const deleteMetadataSpy = vi.spyOn(h.metadata, 'deleteSpaceMetadata')

    await (h.adapter as any).handleMemberUpdate(
      memberUpdateDecoded(ADMIN, { spaceId: space.id, action: 'removed', memberDid: h.alice.getDid(), effectiveKeyGeneration: 1 }))
    expect(repoDeleteSpy).toHaveBeenCalledTimes(1)
    expect(deleteMetadataSpy).toHaveBeenCalledTimes(1)

    // Simuliert eine bereits eingeplante Doc-Change-Handler-Chain, die NACH
    // dem savePending-Cleanup ausgefuehrt wird (Resolution aus zwei Pfaden).
    await (h.adapter as any).resolvePendingMemberUpdates(spaceRef, members)

    expect(repoDeleteSpy).toHaveBeenCalledTimes(1)
    expect(deleteMetadataSpy).toHaveBeenCalledTimes(1)
    expect(spaceState(h.adapter, space.id)).toBeUndefined()
  })

  it('(3) Restore mit nicht-leerem Event-Set + offenem (beantwortetem) Pending → Resolution laeuft beim Restore, Cleanup inklusive', async () => {
    const durableStore = new InMemoryMemberUpdatePendingStore()
    const alice = (await createTestIdentity('am-m1-restore-resolution')).identity
    const messaging = new InMemoryMessagingAdapter()
    await messaging.connect(alice.getDid())
    const metadata = new InMemorySpaceMetadataStorage()
    const compactStore = new InMemoryCompactStore()

    const adapter1 = new AutomergeReplicationAdapter({
      identity: alice, messaging, keyManagement: new InMemoryKeyManagementAdapter(),
      metadataStorage: metadata, compactStore, memberUpdateStore: durableStore,
    })
    await adapter1.start()
    const space = await adapter1.createSpace<TestDoc>('shared', { items: {} }, { name: 'S' })
    seedMembership(adapter1, space.id, ADMIN, [ADMIN])
    await wait()

    // Kanonische Entfernung kommt an, waehrend KEIN Pending offen ist
    // (Deadlock-Vorstufe), das Pending landet danach im durablen Store, ohne
    // dass die Live-Resolution lief (modelliert den Crash zwischen savePending
    // und Resolution bzw. den Alt-Stand vor diesem Fix).
    applyCanonicalMembershipEvent(adapter1, space.id, { did: alice.getDid(), status: 'removed', sinceGeneration: 1 })
    await waitUntil(() => spaceState(adapter1, space.id)?.info.members.includes(alice.getDid()) === false)
    expect(spaceState(adapter1, space.id)).toBeDefined()
    await durableStore.savePending({
      spaceId: space.id, action: 'removed', memberDid: alice.getDid(),
      effectiveKeyGeneration: 1, signerDid: ADMIN, storedDisposition: 'store-pending-and-sync',
    })
    // Restore-Quelle deterministisch persistieren (CompactStore).
    await (adapter1 as any)._saveToCompactStore(spaceState(adapter1, space.id))
    await adapter1.stop()

    const adapter2 = new AutomergeReplicationAdapter({
      identity: alice, messaging, keyManagement: new InMemoryKeyManagementAdapter(),
      metadataStorage: metadata, compactStore, memberUpdateStore: durableStore,
    })
    await adapter2.start()
    cleanups.push(async () => {
      await adapter2.stop()
      try { await alice.deleteStoredIdentity() } catch {}
    })

    // Resolution lief beim Restore (nach Flag-Re-Derivation): Pending
    // aufgeloest, Cleanup gelaufen (Sync 005 Z.253: Bestaetigung lag bereits vor).
    expect(spaceState(adapter2, space.id)).toBeUndefined()
    expect(await adapter2.getSpace(space.id)).toBeNull()
    expect(await metadata.loadAllSpaceMetadata()).toHaveLength(0)
    expect(await durableStore.listSeenForSpace(space.id)).toHaveLength(0)
  })
})

describe('Pflicht-Test 11 — VE-7 Re-Derivation der Pending-Flags beim Restore (Sync 005 Z.253 App-Start)', () => {
  it('mit injiziertem durablem Store: Pending-Flag nach Adapter-Neustart re-deriviert; der Bestaetigungs-Sync bei App-Start ist der automerge-repo-Auto-Sync (dokumentierter No-op, VE-6d)', async () => {
    // Der Test injiziert denselben Store in beide Adapter-Inkarnationen —
    // er modelliert damit einen durablen Store (die produktive durable
    // Verdrahtung ist bewusst 1.D-Scope).
    const durableStore = new InMemoryMemberUpdatePendingStore()
    const alice = (await createTestIdentity('am-res-rederive')).identity
    const messaging = new InMemoryMessagingAdapter()
    await messaging.connect(alice.getDid())
    const metadata = new InMemorySpaceMetadataStorage()
    const compactStore = new InMemoryCompactStore()

    const adapter1 = new AutomergeReplicationAdapter({
      identity: alice, messaging, keyManagement: new InMemoryKeyManagementAdapter(),
      metadataStorage: metadata, compactStore, memberUpdateStore: durableStore,
    })
    await adapter1.start()
    const space = await adapter1.createSpace<TestDoc>('shared', { items: {} }, { name: 'S' })
    seedMembership(adapter1, space.id, ADMIN, [ADMIN])
    // fire-and-forget _saveToCompactStore abwarten (Restore-Quelle)
    await waitUntil(() => compactStore.has(space.id))
    await (adapter1 as any).handleMemberUpdate(
      memberUpdateDecoded(ADMIN, { spaceId: space.id, action: 'removed', memberDid: alice.getDid(), effectiveKeyGeneration: 0 }))
    expect(spaceState(adapter1, space.id).pendingRemoval).toEqual({ effectiveKeyGeneration: 0 })
    await adapter1.stop()

    const adapter2 = new AutomergeReplicationAdapter({
      identity: alice, messaging, keyManagement: new InMemoryKeyManagementAdapter(),
      metadataStorage: metadata, compactStore, memberUpdateStore: durableStore,
    })
    await adapter2.start()
    cleanups.push(async () => {
      await adapter2.stop()
      try { await alice.deleteStoredIdentity() } catch {}
    })

    // Flag aus listSeenForSpace re-deriviert (hoechste effectiveKeyGeneration).
    // Die Restore-Resolution (Review-M1 (b)) loest nur BEANTWORTETE Pendings
    // auf — dieses removed@0 ist unbeantwortet (alices Gewinner-Event ist
    // active@0; removed@0 wuerde den Tie-Break noch gewinnen) und bleibt
    // deshalb als Pending-Flag stehen (Z.194: Aufloesung beim naechsten Sync).
    expect(spaceState(adapter2, space.id)).toBeDefined()
    expect(spaceState(adapter2, space.id).pendingRemoval).toEqual({ effectiveKeyGeneration: 0 })
  })

  it('ehrliche Grenze: mit dem Default-InMemory-Store ist das member-update-Pending nach dem Neustart weg (durable Verdrahtung folgt in 1.D)', async () => {
    const alice = (await createTestIdentity('am-res-volatile')).identity
    const messaging = new InMemoryMessagingAdapter()
    await messaging.connect(alice.getDid())
    const metadata = new InMemorySpaceMetadataStorage()
    const compactStore = new InMemoryCompactStore()

    // KEIN memberUpdateStore injiziert → Default InMemory pro Instanz.
    const adapter1 = new AutomergeReplicationAdapter({
      identity: alice, messaging, keyManagement: new InMemoryKeyManagementAdapter(),
      metadataStorage: metadata, compactStore,
    })
    await adapter1.start()
    const space = await adapter1.createSpace<TestDoc>('shared', { items: {} }, { name: 'S' })
    seedMembership(adapter1, space.id, ADMIN, [ADMIN])
    await waitUntil(() => compactStore.has(space.id))
    await (adapter1 as any).handleMemberUpdate(
      memberUpdateDecoded(ADMIN, { spaceId: space.id, action: 'removed', memberDid: alice.getDid(), effectiveKeyGeneration: 0 }))
    expect(spaceState(adapter1, space.id).pendingRemoval).toBeDefined()
    await adapter1.stop()

    const adapter2 = new AutomergeReplicationAdapter({
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
