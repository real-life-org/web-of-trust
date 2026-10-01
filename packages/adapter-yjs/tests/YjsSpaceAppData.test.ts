import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import type { PublicIdentitySession } from '../../wot-core/src/application/identity'
import { createTestIdentity } from '../../wot-core/tests/helpers/identity-session'
import { InMemoryMessagingAdapter, InProcessLogBroker, InMemoryKeyManagementAdapter, InMemoryCompactStore, InMemorySpaceMetadataStorage } from '@web_of_trust/core/adapters'
import { YjsReplicationAdapter } from '../src/YjsReplicationAdapter'
import { logSyncOptions, deviceIdFrom, type LogSyncOptions } from './helpers/log-sync'
import * as Y from 'yjs'

interface TestDoc {
  notes: string
}

function createAdapter(identity: PublicIdentitySession, messaging: InMemoryMessagingAdapter, log: LogSyncOptions) {
  return new YjsReplicationAdapter({
    ...log,
    identity,
    messaging,
    brokerUrls: ['wss://broker.example.com'],
    keyManagement: new InMemoryKeyManagementAdapter(),
    // Durable pending store: concurrent cross-device writes can race the key
    // handshake; an undecryptable update is then buffered as pending, which
    // requires a durable store (PendingMessageNotDurableError otherwise).
    compactStore: new InMemoryCompactStore(),
  })
}

/**
 * `_meta.appData` — der erweiterbare App-Metadaten-Container (rls#234).
 *
 * Der feste `_meta`-Katalog (name/description/image/modules) deckte nur die
 * Framework-Felder ab; App-Felder wie eine Akzentfarbe landeten im Connector
 * nur im RAM-Cache und verschwanden nach Reload. `appData` ist ein flacher
 * Merge-Patch (null loescht) und lebt als flache, geprefixte Keys in _meta,
 * damit zwei Geraete, die verschiedene Keys schreiben, per CRDT mergen statt
 * sich einen Container zu ueberschreiben (eine geschachtelte Y.Map wuerde
 * beim konkurrierenden Erst-Anlegen racen).
 */
describe('YjsReplicationAdapter — _meta.appData', () => {
  let alice: PublicIdentitySession
  let bob: PublicIdentitySession
  let aliceMessaging: InMemoryMessagingAdapter
  let bobMessaging: InMemoryMessagingAdapter
  let aliceAdapter: YjsReplicationAdapter
  let bobAdapter: YjsReplicationAdapter

  beforeEach(async () => {
    InMemoryMessagingAdapter.resetAll()
    alice = (await createTestIdentity('alice-pass')).identity
    bob = (await createTestIdentity('bob-pass')).identity
    // wot#386: broker-backed transport, log-sync mode — the path the relay accepts
    const broker = new InProcessLogBroker()
    aliceMessaging = new InMemoryMessagingAdapter({ broker, socketId: 'alice-socket' })
    bobMessaging = new InMemoryMessagingAdapter({ broker, socketId: 'bob-socket' })
    await aliceMessaging.connect(alice.getDid())
    await bobMessaging.connect(bob.getDid())
    aliceAdapter = createAdapter(alice, aliceMessaging, await logSyncOptions(deviceIdFrom('a')))
    bobAdapter = createAdapter(bob, bobMessaging, await logSyncOptions(deviceIdFrom('b')))
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

  it('persists appData and surfaces it via getMeta AND SpaceInfo', async () => {
    const space = await aliceAdapter.createSpace<TestDoc>('shared', { notes: '' }, { name: 'A' })
    await aliceAdapter.updateSpace(space.id, { appData: { primaryColor: '#e84b1c' } })

    const handle = await aliceAdapter.openSpace<TestDoc>(space.id)
    expect(handle.getMeta().appData).toEqual({ primaryColor: '#e84b1c' })
    handle.close()

    const info = await aliceAdapter.getSpace(space.id)
    expect(info!.appData).toEqual({ primaryColor: '#e84b1c' })
  })

  it('merges per key — a partial patch cannot erase foreign keys', async () => {
    const space = await aliceAdapter.createSpace<TestDoc>('shared', { notes: '' }, { name: 'A' })
    await aliceAdapter.updateSpace(space.id, { appData: { primaryColor: '#e84b1c' } })
    // Zweiter Writer kennt den ersten nicht (stale caller) und schickt NUR sein Feld.
    await aliceAdapter.updateSpace(space.id, { appData: { theme: 'forest' } })

    const info = await aliceAdapter.getSpace(space.id)
    expect(info!.appData).toEqual({ primaryColor: '#e84b1c', theme: 'forest' })
  })

  it('removes a key via null (JSON Merge Patch at depth 1)', async () => {
    const space = await aliceAdapter.createSpace<TestDoc>('shared', { notes: '' }, { name: 'A' })
    await aliceAdapter.updateSpace(space.id, { appData: { primaryColor: '#e84b1c', theme: 'forest' } })
    await aliceAdapter.updateSpace(space.id, { appData: { primaryColor: null } })

    const info = await aliceAdapter.getSpace(space.id)
    expect(info!.appData).toEqual({ theme: 'forest' })
  })

  it('leaves framework meta untouched and vice versa', async () => {
    const space = await aliceAdapter.createSpace<TestDoc>('shared', { notes: '' }, { name: 'Original' })
    await aliceAdapter.updateSpace(space.id, { appData: { primaryColor: '#e84b1c' } })
    await aliceAdapter.updateSpace(space.id, { name: 'Renamed' })

    const info = await aliceAdapter.getSpace(space.id)
    expect(info!.name).toBe('Renamed')
    expect(info!.appData).toEqual({ primaryColor: '#e84b1c' })
  })

  it('syncs appData to other members (remote SpaceInfo projection)', async () => {
    const space = await aliceAdapter.createSpace<TestDoc>('shared', { notes: '' }, { name: 'Shared' })
    const bobEncKey = await bob.getEncryptionPublicKeyBytes()
    await aliceAdapter.addMember(space.id, bob.getDid(), bobEncKey)
    await new Promise(r => setTimeout(r, 200))

    await aliceAdapter.updateSpace(space.id, { appData: { primaryColor: '#e84b1c' } })
    await new Promise(r => setTimeout(r, 300))

    const bobSpace = await bobAdapter.getSpace(space.id)
    expect(bobSpace!.appData).toEqual({ primaryColor: '#e84b1c' })
  })

  it('concurrent patches of DIFFERENT keys merge instead of clobbering (per-key entries)', async () => {
    const space = await aliceAdapter.createSpace<TestDoc>('shared', { notes: '' }, { name: 'Shared' })
    const bobEncKey = await bob.getEncryptionPublicKeyBytes()
    await aliceAdapter.addMember(space.id, bob.getDid(), bobEncKey)
    await new Promise(r => setTimeout(r, 300))

    // Beide schreiben "gleichzeitig" verschiedene Keys — als ganzer Container
    // gespeichert wuerde ein Write den anderen verdraengen (Container-LWW).
    await Promise.all([
      aliceAdapter.updateSpace(space.id, { appData: { primaryColor: '#e84b1c' } }),
      bobAdapter.updateSpace(space.id, { appData: { theme: 'forest' } }),
    ])
    await new Promise(r => setTimeout(r, 400))

    const aliceView = await aliceAdapter.getSpace(space.id)
    const bobView = await bobAdapter.getSpace(space.id)
    expect(aliceView!.appData).toEqual({ primaryColor: '#e84b1c', theme: 'forest' })
    expect(bobView!.appData).toEqual({ primaryColor: '#e84b1c', theme: 'forest' })
  })
})

describe('YjsReplicationAdapter — appData Robustheit (Review-Runde 2)', () => {
  let alice: PublicIdentitySession
  let aliceMessaging: InMemoryMessagingAdapter
  let aliceAdapter: YjsReplicationAdapter
  let metadataStorage: InMemorySpaceMetadataStorage

  beforeEach(async () => {
    InMemoryMessagingAdapter.resetAll()
    alice = (await createTestIdentity('alice-pass')).identity
    aliceMessaging = new InMemoryMessagingAdapter()
    await aliceMessaging.connect(alice.getDid())
    metadataStorage = new InMemorySpaceMetadataStorage()
    aliceAdapter = new YjsReplicationAdapter({
      identity: alice,
      messaging: aliceMessaging,
      brokerUrls: ['wss://broker.example.com'],
      keyManagement: new InMemoryKeyManagementAdapter(),
      compactStore: new InMemoryCompactStore(),
      metadataStorage,
    })
    await aliceAdapter.start()
  })

  afterEach(async () => {
    await aliceAdapter.stop()
    InMemoryMessagingAdapter.resetAll()
    try { await alice.deleteStoredIdentity() } catch {}
  })

  it('ein reiner appData-Change ist DIRTY — er erreicht die Metadata-Persistenz', async () => {
    const space = await aliceAdapter.createSpace<TestDoc>('shared', { notes: '' }, { name: 'A' })
    await new Promise(r => setTimeout(r, 100))

    // Der SCHARFE Fall ist der zweite appData-only-Change: nach dem ersten
    // Save sind alle uebrigen Fingerprint-Komponenten identisch — fehlt
    // appData im Fingerprint, gilt der Change als "nicht dirty" und der
    // Save wird uebersprungen (stale Persistenz).
    await aliceAdapter.updateSpace(space.id, { appData: { primaryColor: '#e84b1c' } })
    await new Promise(r => setTimeout(r, 200))
    await aliceAdapter.updateSpace(space.id, { appData: { primaryColor: '#123456' } })
    await new Promise(r => setTimeout(r, 200))

    const persisted = await metadataStorage.loadSpaceMetadata(space.id)
    expect(persisted?.info.appData).toEqual({ primaryColor: '#123456' })
  })

  it('Loeschen des LETZTEN Keys laesst keine stale Projektion zurueck', async () => {
    const space = await aliceAdapter.createSpace<TestDoc>('shared', { notes: '' }, { name: 'A' })
    await aliceAdapter.updateSpace(space.id, { appData: { primaryColor: '#e84b1c' } })
    await aliceAdapter.updateSpace(space.id, { appData: { primaryColor: null } })

    const info = await aliceAdapter.getSpace(space.id)
    expect(info!.appData).toBeUndefined()

    const handle = await aliceAdapter.openSpace<TestDoc>(space.id)
    expect(handle.getMeta().appData).toBeUndefined()
    handle.close()
  })

  it('weist __proto__/constructor/prototype als Keys zurueck (Prototype-Pollution)', async () => {
    const space = await aliceAdapter.createSpace<TestDoc>('shared', { notes: '' }, { name: 'A' })
    // JSON.parse erzeugt __proto__ als ECHTEN eigenen Key (ein Objekt-Literal
    // wuerde stattdessen den Prototyp des Literals setzen).
    const malicious = JSON.parse('{"__proto__": {"polluted": true}}') as Record<string, unknown>
    await expect(aliceAdapter.updateSpace(space.id, { appData: malicious })).rejects.toThrow(/appData/)
    await expect(
      aliceAdapter.updateSpace(space.id, { appData: { constructor: 1 } as unknown as Record<string, unknown> }),
    ).rejects.toThrow(/appData/)
    expect(({} as Record<string, unknown>).polluted).toBeUndefined()
  })

  it('weist nicht-JSON-Werte zurueck, ohne den Space-Zustand anzufassen', async () => {
    const space = await aliceAdapter.createSpace<TestDoc>('shared', { notes: '' }, { name: 'A' })
    await aliceAdapter.updateSpace(space.id, { appData: { keep: 'me' } })

    await expect(
      aliceAdapter.updateSpace(space.id, { appData: { fn: (() => {}) as unknown } }),
    ).rejects.toThrow(/appData/)
    await expect(
      aliceAdapter.updateSpace(space.id, { appData: { big: BigInt(1) as unknown } }),
    ).rejects.toThrow(/appData/)

    // Kein Teil-Patch angewendet, Observer lebt: ein valider Folge-Patch geht durch.
    const before = await aliceAdapter.getSpace(space.id)
    expect(before!.appData).toEqual({ keep: 'me' })
    await aliceAdapter.updateSpace(space.id, { appData: { theme: 'forest' } })
    const after = await aliceAdapter.getSpace(space.id)
    expect(after!.appData).toEqual({ keep: 'me', theme: 'forest' })
  })
})

describe('YjsReplicationAdapter — appData Restore/Restart', () => {
  let alice: PublicIdentitySession
  let aliceMessaging: InMemoryMessagingAdapter
  let metadataStorage: InMemorySpaceMetadataStorage
  let compactStore: InMemoryCompactStore
  let keyManagement: InMemoryKeyManagementAdapter
  const adapters: YjsReplicationAdapter[] = []

  function makeAdapter(): YjsReplicationAdapter {
    const adapter = new YjsReplicationAdapter({
      identity: alice,
      messaging: aliceMessaging,
      brokerUrls: ['wss://broker.example.com'],
      keyManagement,
      compactStore,
      metadataStorage,
    })
    adapters.push(adapter)
    return adapter
  }

  beforeEach(async () => {
    InMemoryMessagingAdapter.resetAll()
    alice = (await createTestIdentity('alice-pass')).identity
    aliceMessaging = new InMemoryMessagingAdapter()
    await aliceMessaging.connect(alice.getDid())
    metadataStorage = new InMemorySpaceMetadataStorage()
    compactStore = new InMemoryCompactStore()
    keyManagement = new InMemoryKeyManagementAdapter()
    adapters.length = 0
  })

  afterEach(async () => {
    for (const adapter of adapters) {
      try { await adapter.stop() } catch {}
    }
    InMemoryMessagingAdapter.resetAll()
    try { await alice.deleteStoredIdentity() } catch {}
  })

  it('Loeschen des letzten Keys ueberlebt einen Restart (kein Wiederauferstehen)', async () => {
    const first = makeAdapter()
    await first.start()
    const space = await first.createSpace<TestDoc>('shared', { notes: '' }, { name: 'A' })
    await first.updateSpace(space.id, { appData: { primaryColor: '#e84b1c' } })
    await first.updateSpace(space.id, { appData: { primaryColor: null } })
    await new Promise(r => setTimeout(r, 300))
    await first.stop()

    const second = makeAdapter()
    await second.start()
    await new Promise(r => setTimeout(r, 300))
    const restored = await second.getSpace(space.id)
    expect(restored).toBeTruthy()
    expect(restored!.appData).toBeUndefined()
  })

  it('Legacy-Space mit LEERER _meta-Map: staler appData-Cache aufersteht nicht', async () => {
    // Realistischer Ursprung des stalen Caches: appData wurde einmal gesetzt
    // und in den PersonalDoc-Cache persistiert.
    const first = makeAdapter()
    await first.start()
    const space = await first.createSpace<TestDoc>('shared', { notes: '' }, { name: 'Legacy' })
    await first.updateSpace(space.id, { appData: { primaryColor: '#e84b1c' } })
    await new Promise(r => setTimeout(r, 300))
    await first.stop()

    // Legacy-Doc eines alten Clients: Inhalt vorhanden, _meta komplett LEER
    // (kein name, keine appData-Keys). Der Cache traegt appData noch.
    const legacyDoc = new Y.Doc()
    legacyDoc.transact(() => { legacyDoc.getMap('data').set('notes', 'legacy') })
    await compactStore.save(space.id, Y.encodeStateAsUpdate(legacyDoc))

    const second = makeAdapter()
    await second.start()
    await new Promise(r => setTimeout(r, 300))
    const restored = await second.getSpace(space.id)
    expect(restored).toBeTruthy()
    // Das Doc IST geladen (binary nicht leer) und traegt keine appData-Keys —
    // die Projektion darf den stalen Cache nicht wiederbeleben, auch wenn
    // _meta insgesamt leer ist (metaMap.size waere hier 0).
    expect(restored!.appData).toBeUndefined()
  })
})
