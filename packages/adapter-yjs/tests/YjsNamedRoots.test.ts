import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as Y from 'yjs'
import type { PublicIdentitySession } from '../../wot-core/src/application/identity'
import { createTestIdentity } from '../../wot-core/tests/helpers/identity-session'
import {
  InMemoryMessagingAdapter,
  InProcessLogBroker,
  InMemorySpaceMetadataStorage,
  InMemoryCompactStore,
  InMemoryKeyManagementAdapter,
  InMemoryDocLogStore,
} from '@web_of_trust/core/adapters'
import { hasNamedRoots } from '@web_of_trust/core/application'
import type { AppendLocalEntryParams } from '@web_of_trust/core/ports'
import type { NamedRootsCapable, SpaceHandle } from '@web_of_trust/core'
import { YjsReplicationAdapter } from '../src/YjsReplicationAdapter'

const wait = (ms = 120) => new Promise((r) => setTimeout(r, ms))
const BROKER_URLS = ['wss://broker.example.com']

const ALICE_DEVICE = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const BOB_DEVICE = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'

interface TestDoc {
  items: Record<string, { title: string }>
  shared?: Record<string, unknown>
}

type RootsHandle<T> = SpaceHandle<T> & NamedRootsCapable

/** The doc of a live space — used to prove roots are Y root types, not child maps. */
function docOf(adapter: YjsReplicationAdapter, spaceId: string): Y.Doc {
  return (adapter as unknown as { spaces: Map<string, { doc: Y.Doc }> }).spaces.get(spaceId)!.doc
}

/**
 * Gate the durable log append of ONE space so transactRootDurable can be caught
 * mid-flight (same mechanism as DurableTransact.test.ts).
 */
function gateableStore(store: InMemoryDocLogStore) {
  const real = store.appendLocalEntry.bind(store)
  let armedFor: string | null = null
  let release: () => void = () => {}
  const gate = new Promise<void>((r) => { release = r })
  let gatedOnce = false
  store.appendLocalEntry = async (params: AppendLocalEntryParams) => {
    if (armedFor !== null && params.docId === armedFor && !gatedOnce) {
      gatedOnce = true
      await gate
    }
    return real(params)
  }
  return { arm: (docId: string) => { armedFor = docId }, release: () => release() }
}

/** Minimal in-memory vault that packs snapshots exactly like VaultClient does. */
function makeMemoryVault() {
  const snapshots = new Map<string, { data: string; upToSeq: number }>()
  return {
    snapshots,
    async putSnapshot(docId: string, encryptedData: Uint8Array, nonce: Uint8Array, upToSeq: number) {
      const packed = new Uint8Array(1 + nonce.length + encryptedData.length)
      packed[0] = nonce.length
      packed.set(nonce, 1)
      packed.set(encryptedData, 1 + nonce.length)
      snapshots.set(docId, { data: Buffer.from(packed).toString('base64'), upToSeq })
    },
    async getDocInfo(docId: string) {
      const snap = snapshots.get(docId)
      if (!snap) return null
      return { latestSeq: snap.upToSeq, snapshotSeq: snap.upToSeq, changeCount: 0 }
    },
    async getChanges(docId: string) {
      const snap = snapshots.get(docId)
      return { docId, snapshot: snap ? { ...snap } : null, changes: [] as unknown[] }
    },
    async pushChange() { return 0 },
    async deleteDoc(docId: string) { snapshots.delete(docId) },
  }
}

describe('Yjs — benannte Wurzel-Maps je Space-Doc (NamedRootsCapable)', () => {
  let alice: PublicIdentitySession
  let bob: PublicIdentitySession
  let broker: InProcessLogBroker
  let aliceMessaging: InMemoryMessagingAdapter
  let bobMessaging: InMemoryMessagingAdapter
  let aliceAdapter: YjsReplicationAdapter
  let bobAdapter: YjsReplicationAdapter
  let aliceMeta: InMemorySpaceMetadataStorage
  let aliceCompact: InMemoryCompactStore
  let aliceKeys: InMemoryKeyManagementAdapter
  let aliceLog: InMemoryDocLogStore
  let gate: ReturnType<typeof gateableStore>

  async function makeAdapter(
    identity: PublicIdentitySession,
    messaging: InMemoryMessagingAdapter,
    deviceId: string,
    stores?: {
      metadataStorage?: InMemorySpaceMetadataStorage
      compactStore?: InMemoryCompactStore
      keyManagement?: InMemoryKeyManagementAdapter
      docLogStore?: InMemoryDocLogStore
      vault?: unknown
    },
  ): Promise<YjsReplicationAdapter> {
    const docLogStore = stores?.docLogStore ?? new InMemoryDocLogStore()
    if (!stores?.docLogStore) {
      await docLogStore.init()
      await docLogStore.setDeviceId(deviceId)
    }
    return new YjsReplicationAdapter({
      identity,
      messaging,
      brokerUrls: BROKER_URLS,
      keyManagement: stores?.keyManagement ?? new InMemoryKeyManagementAdapter(),
      metadataStorage: stores?.metadataStorage ?? new InMemorySpaceMetadataStorage(),
      compactStore: stores?.compactStore ?? new InMemoryCompactStore(),
      docLogStore,
      deviceId,
      ...(stores?.vault ? { vault: stores.vault as never } : {}),
    })
  }

  beforeEach(async () => {
    InMemoryMessagingAdapter.resetAll()
    broker = new InProcessLogBroker()
    alice = (await createTestIdentity('alice-roots')).identity
    bob = (await createTestIdentity('bob-roots')).identity

    aliceMessaging = new InMemoryMessagingAdapter({ broker, socketId: 'alice-socket' })
    bobMessaging = new InMemoryMessagingAdapter({ broker, socketId: 'bob-socket' })
    await aliceMessaging.connect(alice.getDid())
    await bobMessaging.connect(bob.getDid())

    aliceMeta = new InMemorySpaceMetadataStorage()
    aliceCompact = new InMemoryCompactStore()
    aliceKeys = new InMemoryKeyManagementAdapter()
    aliceLog = new InMemoryDocLogStore()
    await aliceLog.init()
    await aliceLog.setDeviceId(ALICE_DEVICE)
    gate = gateableStore(aliceLog)

    aliceAdapter = await makeAdapter(alice, aliceMessaging, ALICE_DEVICE, {
      metadataStorage: aliceMeta, compactStore: aliceCompact, keyManagement: aliceKeys, docLogStore: aliceLog,
    })
    bobAdapter = await makeAdapter(bob, bobMessaging, BOB_DEVICE)

    await aliceAdapter.start()
    await bobAdapter.start()
  })

  afterEach(async () => {
    await aliceAdapter.stop().catch(() => {})
    await bobAdapter.stop().catch(() => {})
    InMemoryMessagingAdapter.resetAll()
    try { await alice.deleteStoredIdentity() } catch {}
    try { await bob.deleteStoredIdentity() } catch {}
  })

  async function createSharedSpace(): Promise<string> {
    const space = await aliceAdapter.createSpace<TestDoc>('shared', { items: {} }, { name: 'Roots Space' })
    await wait()
    const bobEncKey = await bob.getEncryptionPublicKeyBytes()
    await aliceAdapter.addMember(space.id, bob.getDid(), bobEncKey)
    await wait(200)
    return space.id
  }

  // ── Vertrag ────────────────────────────────────────────────────────────────
  it('das Space-Handle bietet die Capability an', async () => {
    const spaceId = await createSharedSpace()
    const handle = await aliceAdapter.openSpace<TestDoc>(spaceId)
    expect(hasNamedRoots(handle)).toBe(true)
    handle.close()
  })

  it('verletzte Namen werfen synchron', async () => {
    const spaceId = await createSharedSpace()
    const handle = await aliceAdapter.openSpace<TestDoc>(spaceId) as RootsHandle<TestDoc>
    for (const bad of ['data', '_meta', '_members', 'Profiles', '1x', 'a-b', '']) {
      expect(() => handle.getRoot(bad)).toThrow()
      expect(() => handle.transactRoot(bad, () => {})).toThrow()
      // synchron, damit ein try/catch um den Aufruf greift — nicht als Rejection
      expect(() => handle.transactRootDurable(bad, () => {})).toThrow()
    }
    handle.close()
  })

  it('getRoot ist leer, solange nie geschrieben wurde, und liefert eine Kopie', async () => {
    const spaceId = await createSharedSpace()
    const handle = await aliceAdapter.openSpace<TestDoc>(spaceId) as RootsHandle<TestDoc>
    expect(handle.getRoot('profiles')).toEqual({})

    handle.transactRoot<{ a?: { n: number } }>('profiles', (root) => { root.a = { n: 1 } })
    const snap = handle.getRoot<{ a: { n: number } }>('profiles')
    snap.a.n = 99
    delete (snap as Record<string, unknown>).a
    expect(handle.getRoot<{ a: { n: number } }>('profiles').a.n).toBe(1)
    handle.close()
  })

  it('Objekte liegen als JSON im Register, nicht als Kind-Y.Map', async () => {
    const spaceId = await createSharedSpace()
    const handle = await aliceAdapter.openSpace<TestDoc>(spaceId) as RootsHandle<TestDoc>
    handle.transactRoot('profiles', (root) => {
      ;(root as Record<string, unknown>).a = { deep: { list: [1, 2, 3] } }
    })
    const ymap = docOf(aliceAdapter, spaceId).getMap('profiles')
    expect(ymap.get('a') instanceof Y.Map).toBe(false)
    expect(ymap.get('a') instanceof Y.Array).toBe(false)
    expect(handle.getRoot('profiles')).toEqual({ a: { deep: { list: [1, 2, 3] } } })
    handle.close()
  })

  it('undefined loescht wie delete', async () => {
    const spaceId = await createSharedSpace()
    const handle = await aliceAdapter.openSpace<TestDoc>(spaceId) as RootsHandle<TestDoc>
    handle.transactRoot('profiles', (root) => {
      ;(root as Record<string, unknown>).a = 1
      ;(root as Record<string, unknown>).b = 2
      ;(root as Record<string, unknown>).c = 3
    })
    handle.transactRoot('profiles', (root) => {
      ;(root as Record<string, unknown>).a = undefined
      delete (root as Record<string, unknown>).b
    })
    expect(handle.getRoot('profiles')).toEqual({ c: 3 })
    handle.close()
  })

  it('nicht-JSON-Werte werfen, bevor die Transaktion etwas schreibt', async () => {
    const spaceId = await createSharedSpace()
    const handle = await aliceAdapter.openSpace<TestDoc>(spaceId) as RootsHandle<TestDoc>
    expect(() => handle.transactRoot('profiles', (root) => {
      ;(root as Record<string, unknown>).fn = () => {}
    })).toThrow()
    expect(handle.getRoot('profiles')).toEqual({})
    handle.close()
  })

  it('eine geworfene Zuweisung laesst KEINEN Teil-Patch zurueck (Atomaritaet)', async () => {
    const spaceId = await createSharedSpace()
    const handle = await aliceAdapter.openSpace<TestDoc>(spaceId) as RootsHandle<TestDoc>
    expect(() => handle.transactRoot('profiles', (root) => {
      ;(root as Record<string, unknown>).good = 1
      ;(root as Record<string, unknown>).bad = () => {}
    })).toThrow()
    expect(handle.getRoot('profiles')).toEqual({})

    expect(() => handle.transactRootDurable('profiles', (root) => {
      ;(root as Record<string, unknown>).good = 1
      ;(root as Record<string, unknown>).bad = () => {}
    })).toThrow()
    expect(handle.getRoot('profiles')).toEqual({})
    handle.close()
  })

  it('Nicht-JSON in der TIEFE wirft ebenfalls, statt still zu verschwinden', async () => {
    const spaceId = await createSharedSpace()
    const handle = await aliceAdapter.openSpace<TestDoc>(spaceId) as RootsHandle<TestDoc>
    for (const bad of [{ deep: { fn: () => {} } }, { deep: { n: Infinity } }, { deep: [1, undefined] }, { m: new Map() }]) {
      expect(() => handle.transactRoot('profiles', (root) => {
        ;(root as Record<string, unknown>).a = bad
      })).toThrow()
    }
    expect(handle.getRoot('profiles')).toEqual({})
    handle.close()
  })

  it('prototyp-vergiftende Schluessel werden abgelehnt — auch verschachtelt', async () => {
    // Yjs traegt eine eigene __proto__-Property nicht durch seinen Binaer-Codec.
    // Ein Schluessel, der den Sync nicht ueberlebt, wird laut abgelehnt statt
    // still verloren.
    const spaceId = await createSharedSpace()
    const handle = await aliceAdapter.openSpace<TestDoc>(spaceId) as RootsHandle<TestDoc>
    expect(() => handle.transactRoot('profiles', (root) => {
      ;(root as Record<string, unknown>)['__proto__'] = { hidden: 7 }
    })).toThrow(/__proto__/)
    expect(() => handle.transactRoot('profiles', (root) => {
      ;(root as Record<string, unknown>).a = JSON.parse('{"__proto__":{"hidden":7},"n":1}')
    })).toThrow(/__proto__/)
    expect(handle.getRoot('profiles')).toEqual({})
    expect(({} as { hidden?: unknown }).hidden).toBeUndefined()
    handle.close()
  })

  it('ein aus dem Entwurf entkommener Wert kann das Doc nicht nachtraeglich veraendern', async () => {
    const spaceId = await createSharedSpace()
    const handle = await aliceAdapter.openSpace<TestDoc>(spaceId) as RootsHandle<TestDoc>

    let leaked: Record<string, unknown> | undefined
    handle.transactRoot('profiles', (root) => {
      const r = root as Record<string, unknown>
      r.a = { n: 1 }
      leaked = r.a as Record<string, unknown>
      // Ein Umweg ueber den gelesenen Wert darf die JSON-Pruefung nicht umgehen.
      expect(() => { (r.a as Record<string, unknown>).bad = () => {} }).toThrow()
    })
    expect(() => { leaked!.n = 2 }).toThrow()
    expect(handle.getRoot('profiles')).toEqual({ a: { n: 1 } })

    // Auch ueber den Deskriptor-Pfad entkommt kein lebender Verweis.
    handle.transactRoot('profiles', (root) => {
      const descriptor = Object.getOwnPropertyDescriptor(root, 'a')!
      expect(() => { (descriptor.get!() as Record<string, unknown>).n = 99 }).toThrow()
    })
    expect(handle.getRoot('profiles')).toEqual({ a: { n: 1 } })

    // Object.defineProperty taeuscht keinen Schreibvorgang vor.
    expect(() => handle.transactRoot('profiles', (root) => {
      Object.defineProperty(root, 'sneaky', { value: 1, configurable: true, enumerable: true })
    })).toThrow(/defineProperty/)
    expect(handle.getRoot('profiles')).toEqual({ a: { n: 1 } })
    handle.close()
  })

  it('ein unprojizierbarer Fremdwert blockiert weder Aufzaehlung noch Loeschen', async () => {
    const spaceId = await createSharedSpace()
    const handle = await aliceAdapter.openSpace<TestDoc>(spaceId) as RootsHandle<TestDoc>
    handle.transactRoot('profiles', (root) => { (root as Record<string, unknown>).ok = 1 })
    // Was ein fremdes Geraet schreiben koennte, aber unsere Schreibseite nie
    // zulaesst: ein CRDT-Typ als Wurzel-Wert.
    docOf(aliceAdapter, spaceId).transact(() => {
      docOf(aliceAdapter, spaceId).getMap('profiles').set('foreign', new Y.Map())
    }, 'local')

    expect(handle.getRoot('profiles')).toEqual({ ok: 1 }) // Projektion ueberspringt ihn
    handle.transactRoot('profiles', (root) => {
      const r = root as Record<string, unknown>
      expect(Object.keys(r).sort()).toEqual(['foreign', 'ok'])
      for (const key of Object.keys(r)) delete r[key]
    })
    expect(handle.getRoot('profiles')).toEqual({})
    handle.close()
  })

  it('getRoot liefert eine MUTIERBARE Kopie (der Entwurf bleibt eingefroren)', async () => {
    const spaceId = await createSharedSpace()
    const handle = await aliceAdapter.openSpace<TestDoc>(spaceId) as RootsHandle<TestDoc>
    handle.transactRoot('profiles', (root) => { (root as Record<string, unknown>).a = { n: 1 } })
    const snap = handle.getRoot<{ a: { n: number } }>('profiles')
    snap.a.n = 99
    expect(handle.getRoot<{ a: { n: number } }>('profiles').a.n).toBe(1)
    handle.close()
  })

  it('sparse Arrays werden abgelehnt, statt als undefined zurueckzukommen', async () => {
    const spaceId = await createSharedSpace()
    const handle = await aliceAdapter.openSpace<TestDoc>(spaceId) as RootsHandle<TestDoc>
    expect(() => handle.transactRoot('profiles', (root) => {
      ;(root as Record<string, unknown>).a = Array(1)
    })).toThrow()
    expect(handle.getRoot('profiles')).toEqual({})
    handle.close()
  })

  it('ein festgehaltener Entwurf kann nach der Transaktion nicht mehr schreiben', async () => {
    const spaceId = await createSharedSpace()
    const handle = await aliceAdapter.openSpace<TestDoc>(spaceId) as RootsHandle<TestDoc>
    let escaped: Record<string, unknown> | undefined
    handle.transactRoot('profiles', (root) => {
      escaped = root as Record<string, unknown>
      ;(root as Record<string, unknown>).a = 1
    })
    expect(() => { escaped!.b = 2 }).toThrow()
    expect(() => { delete escaped!.a }).toThrow()
    expect(handle.getRoot('profiles')).toEqual({ a: 1 })
    handle.close()
  })

  it('im Entwurf ist der eigene Zwischenstand lesbar', async () => {
    const spaceId = await createSharedSpace()
    const handle = await aliceAdapter.openSpace<TestDoc>(spaceId) as RootsHandle<TestDoc>
    handle.transactRoot('profiles', (root) => { (root as Record<string, unknown>).a = { n: 1 } })
    handle.transactRoot('profiles', (root) => {
      const r = root as Record<string, unknown>
      expect(r.a).toEqual({ n: 1 })
      expect(Object.keys(r)).toEqual(['a'])
      r.b = 2
      expect(r.b).toBe(2)
      expect(Object.keys(r).sort()).toEqual(['a', 'b'])
      delete r.a
      expect(r.a).toBeUndefined()
      expect(Object.keys(r)).toEqual(['b'])
    })
    expect(handle.getRoot('profiles')).toEqual({ b: 2 })
    handle.close()
  })

  // ── Der eigentliche Fehlerfall (rls#353) ───────────────────────────────────
  it('nebenlaeufige Erstanlage: beide Geraete behalten BEIDE Schluessel', async () => {
    const spaceId = await createSharedSpace()
    const aliceHandle = await aliceAdapter.openSpace<TestDoc>(spaceId) as RootsHandle<TestDoc>
    const bobHandle = await bobAdapter.openSpace<TestDoc>(spaceId) as RootsHandle<TestDoc>

    // Beide schreiben im SELBEN Tick in die bisher nie geschriebene Wurzel.
    aliceHandle.transactRoot('profiles', (root) => { (root as Record<string, unknown>)['alice'] = { n: 'A' } })
    bobHandle.transactRoot('profiles', (root) => { (root as Record<string, unknown>)['bob'] = { n: 'B' } })

    await wait(200)
    await aliceAdapter.requestSync(spaceId)
    await bobAdapter.requestSync(spaceId)
    await wait(200)

    expect(aliceHandle.getRoot('profiles')).toEqual({ alice: { n: 'A' }, bob: { n: 'B' } })
    expect(bobHandle.getRoot('profiles')).toEqual({ alice: { n: 'A' }, bob: { n: 'B' } })
    aliceHandle.close(); bobHandle.close()
  })

  it('Gegenprobe: dasselbe ueber transact in `data` verliert einen Schluessel', async () => {
    const spaceId = await createSharedSpace()
    const aliceHandle = await aliceAdapter.openSpace<TestDoc>(spaceId)
    const bobHandle = await bobAdapter.openSpace<TestDoc>(spaceId)

    aliceHandle.transact((doc) => { doc.shared = { alice: { n: 'A' } } })
    bobHandle.transact((doc) => { doc.shared = { bob: { n: 'B' } } })

    await wait(200)
    await aliceAdapter.requestSync(spaceId)
    await bobAdapter.requestSync(spaceId)
    await wait(200)

    const aliceShared = aliceHandle.getDoc().shared ?? {}
    const bobShared = bobHandle.getDoc().shared ?? {}
    expect(aliceShared).toEqual(bobShared)          // konvergiert …
    expect(Object.keys(aliceShared)).toHaveLength(1) // … aber ein Unterbaum ist weg
    aliceHandle.close(); bobHandle.close()
  })

  it('LWW auf demselben Schluessel verliert keinen ANDEREN Schluessel', async () => {
    const spaceId = await createSharedSpace()
    const aliceHandle = await aliceAdapter.openSpace<TestDoc>(spaceId) as RootsHandle<TestDoc>
    const bobHandle = await bobAdapter.openSpace<TestDoc>(spaceId) as RootsHandle<TestDoc>

    aliceHandle.transactRoot('profiles', (root) => { (root as Record<string, unknown>)['keep'] = 'alice-only' })
    await wait(200)
    await bobAdapter.requestSync(spaceId)
    await wait(200)

    aliceHandle.transactRoot('profiles', (root) => { (root as Record<string, unknown>)['contested'] = 'A' })
    bobHandle.transactRoot('profiles', (root) => { (root as Record<string, unknown>)['contested'] = 'B' })
    await wait(200)
    await aliceAdapter.requestSync(spaceId)
    await bobAdapter.requestSync(spaceId)
    await wait(200)

    const a = aliceHandle.getRoot<Record<string, string>>('profiles')
    const b = bobHandle.getRoot<Record<string, string>>('profiles')
    expect(a).toEqual(b)
    expect(a.keep).toBe('alice-only')
    expect(['A', 'B']).toContain(a.contested)
    aliceHandle.close(); bobHandle.close()
  })

  it('onRemoteUpdate feuert bei einer Wurzel-Aenderung des anderen Geraets', async () => {
    const spaceId = await createSharedSpace()
    const aliceHandle = await aliceAdapter.openSpace<TestDoc>(spaceId) as RootsHandle<TestDoc>
    const bobHandle = await bobAdapter.openSpace<TestDoc>(spaceId) as RootsHandle<TestDoc>

    let fired = 0
    const unsub = bobHandle.onRemoteUpdate(() => { fired += 1 })
    aliceHandle.transactRoot('profiles', (root) => { (root as Record<string, unknown>)['alice'] = 1 })
    await wait(300)

    expect(fired).toBeGreaterThan(0)
    expect(bobHandle.getRoot('profiles')).toEqual({ alice: 1 })
    unsub(); aliceHandle.close(); bobHandle.close()
  })

  // ── Persistenz ─────────────────────────────────────────────────────────────
  it('die Wurzel ueberlebt einen Compact-Store-Restore', async () => {
    const spaceId = await createSharedSpace()
    const handle = await aliceAdapter.openSpace<TestDoc>(spaceId) as RootsHandle<TestDoc>
    handle.transactRoot('profiles', (root) => { (root as Record<string, unknown>)['a'] = { n: 1 } })
    handle.close()
    await wait(200)
    await aliceAdapter.stop()

    const restartLog = new InMemoryDocLogStore()
    await restartLog.init()
    await restartLog.setDeviceId(ALICE_DEVICE)
    // Isolation: ein FRISCHER (leerer) Broker — so kann der Log-Catch-up die
    // Wurzel nicht liefern, der Compact-Store ist die einzige Quelle.
    const isolatedMessaging = new InMemoryMessagingAdapter({ broker: new InProcessLogBroker(), socketId: 'alice-restart' })
    await isolatedMessaging.connect(alice.getDid())
    const restarted = await makeAdapter(alice, isolatedMessaging, ALICE_DEVICE, {
      metadataStorage: aliceMeta, compactStore: aliceCompact, keyManagement: aliceKeys, docLogStore: restartLog,
    })
    await restarted.start()
    await wait(200)
    const restoredHandle = await restarted.openSpace<TestDoc>(spaceId) as RootsHandle<TestDoc>
    expect(restoredHandle.getRoot('profiles')).toEqual({ a: { n: 1 } })
    restoredHandle.close()
    await restarted.stop()
    aliceAdapter = restarted // afterEach stops it again (idempotent)
  })

  it('die Wurzel ueberlebt einen Vault-Restore (leerer Compact-Store)', async () => {
    const vault = makeMemoryVault()
    const vaultMeta = new InMemorySpaceMetadataStorage()
    const vaultKeys = new InMemoryKeyManagementAdapter()
    const vaultLog = new InMemoryDocLogStore()
    await vaultLog.init()
    await vaultLog.setDeviceId(ALICE_DEVICE)
    const writerMessaging = new InMemoryMessagingAdapter({ broker: new InProcessLogBroker(), socketId: 'alice-vault-writer' })
    await writerMessaging.connect(alice.getDid())
    const writer = await makeAdapter(alice, writerMessaging, ALICE_DEVICE, {
      metadataStorage: vaultMeta, compactStore: new InMemoryCompactStore(), keyManagement: vaultKeys,
      docLogStore: vaultLog, vault,
    })
    await writer.start()
    const space = await writer.createSpace<TestDoc>('shared', { items: {} }, { name: 'Vault Roots' })
    const writerHandle = await writer.openSpace<TestDoc>(space.id) as RootsHandle<TestDoc>
    writerHandle.transactRoot('profiles', (root) => { (root as Record<string, unknown>)['a'] = { n: 7 } })
    await wait(300)
    writerHandle.close()
    await writer.stop()
    expect(vault.snapshots.has(space.id)).toBe(true)

    // Fresh device: same metadata + keys, but an EMPTY compact store.
    const readerLog = new InMemoryDocLogStore()
    await readerLog.init()
    await readerLog.setDeviceId('cccccccc-cccc-4ccc-8ccc-cccccccccccc')
    // Isolation: frischer (leerer) Broker + leerer Compact-Store — der Vault ist
    // die einzig moegliche Quelle der Wurzel.
    const readerMessaging = new InMemoryMessagingAdapter({ broker: new InProcessLogBroker(), socketId: 'alice-vault-reader' })
    await readerMessaging.connect(alice.getDid())
    const reader = await makeAdapter(alice, readerMessaging, 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', {
      metadataStorage: vaultMeta, compactStore: new InMemoryCompactStore(), keyManagement: vaultKeys,
      docLogStore: readerLog, vault,
    })
    await reader.start()
    await reader.requestSync(space.id)
    await wait(300)
    const readerHandle = await reader.openSpace<TestDoc>(space.id) as RootsHandle<TestDoc>
    expect(readerHandle.getRoot('profiles')).toEqual({ a: { n: 7 } })
    readerHandle.close()
    await reader.stop()
  })

  it('die Wurzel kommt beim Reconnect-Catch-up eines kalten Geraets mit', async () => {
    const spaceId = await createSharedSpace()
    const bobStores = bobAdapter as unknown as {
      metadataStorage: InMemorySpaceMetadataStorage
      compactStore: InMemoryCompactStore
      keyManagement: InMemoryKeyManagementAdapter
    }
    await bobAdapter.stop()
    await bobMessaging.disconnect()

    const aliceHandle = await aliceAdapter.openSpace<TestDoc>(spaceId) as RootsHandle<TestDoc>
    aliceHandle.transactRoot('profiles', (root) => { (root as Record<string, unknown>)['offline'] = { n: 'while bob was away' } })
    await wait(200)

    const coldMessaging = new InMemoryMessagingAdapter({ broker, socketId: 'bob-cold-socket' })
    await coldMessaging.connect(bob.getDid())
    const coldLog = new InMemoryDocLogStore()
    await coldLog.init()
    await coldLog.setDeviceId('cccccccc-cccc-4ccc-8ccc-cccccccccccc')
    const cold = await makeAdapter(bob, coldMessaging, 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', {
      metadataStorage: bobStores.metadataStorage,
      compactStore: bobStores.compactStore,
      keyManagement: bobStores.keyManagement,
      docLogStore: coldLog,
    })
    await cold.start()
    await cold.requestSync(spaceId)
    await wait(400)

    const coldHandle = await cold.openSpace<TestDoc>(spaceId) as RootsHandle<TestDoc>
    expect(coldHandle.getRoot('profiles')).toEqual({ offline: { n: 'while bob was away' } })
    coldHandle.close()
    aliceHandle.close()
    await cold.stop()
    bobAdapter = cold
  })

  // ── Durabilitaet ───────────────────────────────────────────────────────────
  it('transactRootDurable loest erst nach dem Log-Append auf', async () => {
    const spaceId = await createSharedSpace()
    const handle = await aliceAdapter.openSpace<TestDoc>(spaceId) as RootsHandle<TestDoc>

    gate.arm(spaceId)
    let settled = false
    const durable = handle.transactRootDurable('profiles', (root) => {
      ;(root as Record<string, unknown>)['durable'] = { n: 1 }
    }).then(() => { settled = true })

    await wait(80)
    expect(settled).toBe(false)
    gate.release()
    await durable
    expect(settled).toBe(true)
    expect(handle.getRoot('profiles')).toEqual({ durable: { n: 1 } })
    handle.close()
  })

  it('eine leere transactRootDurable-Transaktion loest sofort auf', async () => {
    const spaceId = await createSharedSpace()
    const handle = await aliceAdapter.openSpace<TestDoc>(spaceId) as RootsHandle<TestDoc>
    await expect(handle.transactRootDurable('profiles', () => {})).resolves.toBeUndefined()
    handle.close()
  })
})
