import { describe, it, expect, afterEach } from 'vitest'
import * as Y from 'yjs'
import type { PublicIdentitySession } from '../../wot-core/src/application/identity'
import { createTestIdentity } from '../../wot-core/tests/helpers/identity-session'
import {
  InMemoryMessagingAdapter,
  InMemoryCompactStore,
  InMemoryDocLogStore,
  InMemoryKeyManagementAdapter,
  InProcessLogBroker,
  PersonalDocSpaceMetadataStorage,
} from '@web_of_trust/core/adapters'
import type { AppendLocalEntryParams } from '@web_of_trust/core/ports'
import { YjsReplicationAdapter } from '../src/YjsReplicationAdapter'

const BROKER_URLS = ['wss://broker.example.com']
const DEVICE = 'd1111111-1111-4111-8111-111111111111'

interface TestDoc { items: Record<string, { title: string }> }

async function waitUntil(cond: () => boolean | Promise<boolean>, what: string, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await cond()) return
    await new Promise((r) => setTimeout(r, 10))
  }
  throw new Error(`Timed out waiting for ${what}`)
}

function metadataInPersonalDoc(doc: Y.Doc): PersonalDocSpaceMetadataStorage {
  const roots = ['spaces', 'groupKeys', 'capabilitySigningSeeds']
  const read = () => Object.fromEntries(roots.map((root) => [root, doc.getMap(root).toJSON()]))
  const write = (state: Record<string, Record<string, unknown>>) => {
    doc.transact(() => {
      for (const root of roots) {
        const map = doc.getMap(root)
        map.clear()
        for (const [key, value] of Object.entries(state[root] ?? {})) map.set(key, value)
      }
    }, 'local')
  }
  return new PersonalDocSpaceMetadataStorage({
    getPersonalDoc: read,
    changePersonalDoc: (change) => { const s = read(); change(s); write(s) },
  })
}

/**
 * Arms an append gate AFTER setup: once armed, the first appendLocalEntry for the
 * given doc blocks on the gate (or throws, when `fail` is set). All other appends
 * — including a concurrent foreign edit's — pass through untouched.
 */
function gateableStore(store: InMemoryDocLogStore) {
  const real = store.appendLocalEntry.bind(store)
  let armedFor: string | null = null
  let fail = false
  let release: () => void = () => {}
  const gate = new Promise<void>((r) => { release = r })
  let gatedOnce = false
  store.appendLocalEntry = async (params: AppendLocalEntryParams) => {
    if (armedFor !== null && params.docId === armedFor && !gatedOnce) {
      gatedOnce = true
      if (fail) throw new Error('injected append failure')
      await gate
    }
    return real(params)
  }
  return { arm: (docId: string) => { armedFor = docId }, failNext: (docId: string) => { armedFor = docId; fail = true }, release: () => release() }
}

async function setup() {
  const broker = new InProcessLogBroker()
  const { identity } = await createTestIdentity('durable-transact')
  const messaging = new InMemoryMessagingAdapter({ broker, socketId: 'durable-transact' })
  await messaging.connect(identity.getDid())
  const docLogStore = new InMemoryDocLogStore()
  await docLogStore.init()
  await docLogStore.setDeviceId(DEVICE)
  const gate = gateableStore(docLogStore)
  const keyManagement = new InMemoryKeyManagementAdapter()
  const adapter = new YjsReplicationAdapter({
    identity, messaging, brokerUrls: BROKER_URLS,
    metadataStorage: metadataInPersonalDoc(new Y.Doc()),
    keyManagement,
    compactStore: new InMemoryCompactStore(),
    docLogStore, deviceId: DEVICE,
  })
  await adapter.start()
  const space = await adapter.createSpace<TestDoc>('shared', { items: {} }, { name: 'Durable' })
  const handle = await adapter.openSpace<TestDoc>(space.id)
  return { identity, adapter, handle, space, docLogStore, gate, keyManagement }
}

describe('SpaceHandle.transactDurable — Yjs', () => {
  const cleanup: Array<() => Promise<void>> = []
  afterEach(async () => {
    while (cleanup.length) await cleanup.pop()!().catch(() => {})
    InMemoryMessagingAdapter.resetAll()
  })

  it('resolves only after ITS OWN append is durable — a concurrent foreign append does not open the gate', async () => {
    const { identity, adapter, handle, space, docLogStore, gate } = await setup()
    cleanup.push(async () => { handle.close(); await adapter.stop(); await identity.deleteStoredIdentity() })
    const seqBefore = (await docLogStore.getKnownHeads(space.id))[DEVICE] ?? 0

    gate.arm(space.id)
    let settled = false
    const durable = handle.transactDurable!((doc) => { doc.items['durable'] = { title: 'mine' } })
      .then(() => { settled = true })

    // A FOREIGN local edit of the same space appends durably in the meantime —
    // the reviewer's repro: generic head movement must NOT satisfy the gate.
    handle.transact((doc) => { doc.items['foreign'] = { title: 'other' } })
    await waitUntil(async () => ((await docLogStore.getKnownHeads(space.id))[DEVICE] ?? 0) > seqBefore, 'the foreign append')
    await new Promise((r) => setTimeout(r, 50))
    expect(settled).toBe(false) // head moved, gate still closed — the ack is transaction-bound

    gate.release()
    await durable
    expect(settled).toBe(true)
    expect(handle.getDoc().items['durable'].title).toBe('mine')
  })

  it('rejects when the append of its transaction fails', async () => {
    const { identity, adapter, handle, space, gate } = await setup()
    cleanup.push(async () => { handle.close(); await adapter.stop(); await identity.deleteStoredIdentity() })
    gate.failNext(space.id)
    await expect(handle.transactDurable!((doc) => { doc.items['x'] = { title: 'x' } })).rejects.toThrow(/injected append failure/)
  })

  it('rejects fail-closed when no content key is available (append silently skipped)', async () => {
    // writeLocalUpdate() returns null without appending when the content key is
    // missing (key recovery / blocked-by-key). That must NOT count as durable.
    const { identity, adapter, handle, keyManagement } = await setup()
    cleanup.push(async () => { handle.close(); await adapter.stop(); await identity.deleteStoredIdentity() })
    keyManagement.getKeyByGeneration = async () => null // key material gone after openSpace
    await expect(handle.transactDurable!((doc) => { doc.items['x'] = { title: 'x' } })).rejects.toThrow(/no content key/)
  })

  it('a failed append followed by the SAME re-set yields a NEW confirmed append (the #192 retry contract)', async () => {
    const { identity, adapter, handle, space, docLogStore, gate } = await setup()
    cleanup.push(async () => { handle.close(); await adapter.stop(); await identity.deleteStoredIdentity() })

    gate.failNext(space.id)
    await expect(handle.transactDurable!((doc) => { doc.items['m'] = { title: 'Precious' } })).rejects.toThrow(/injected append failure/)
    // The mutation IS locally visible — exactly the crash-retry starting point.
    expect(handle.getDoc().items['m'].title).toBe('Precious')
    const seqAfterFailure = (await docLogStore.getKnownHeads(space.id))[DEVICE] ?? 0

    // Idempotent same-bytes re-set: MUST produce a fresh confirmed append.
    await handle.transactDurable!((doc) => { doc.items['m'] = { title: 'Precious' } })
    const seqAfterRetry = (await docLogStore.getKnownHeads(space.id))[DEVICE] ?? 0
    expect(seqAfterRetry).toBeGreaterThan(seqAfterFailure)
  })

  it('rejects BEFORE mutating in the local-only configuration (no silent local divergence)', async () => {
    // CodeRabbit repro: without a log path the old code applied the change
    // (skipped by the observer via the durable origin) and only then rejected —
    // leaving a silently diverged local doc. It must fail fast instead.
    // Local-only = no docLogStore (wot#386: the log path is the only replication path).
    const { identity } = await createTestIdentity('durable-no-logsync')
    const messaging = new InMemoryMessagingAdapter()
    await messaging.connect(identity.getDid())
    const adapter = new YjsReplicationAdapter({
      identity, messaging, brokerUrls: BROKER_URLS,
      metadataStorage: metadataInPersonalDoc(new Y.Doc()),
      keyManagement: new InMemoryKeyManagementAdapter(),
      compactStore: new InMemoryCompactStore(),
      deviceId: DEVICE,
    })
    await adapter.start()
    const space = await adapter.createSpace<TestDoc>('shared', { items: {} }, { name: 'NoLogSync' })
    const handle = await adapter.openSpace<TestDoc>(space.id)
    cleanup.push(async () => { handle.close(); await adapter.stop(); await identity.deleteStoredIdentity() })

    await expect(handle.transactDurable!((doc) => { doc.items['x'] = { title: 'diverged?' } })).rejects.toThrow(/log-sync configuration/)
    expect(handle.getDoc().items['x']).toBeUndefined() // the doc must be untouched
  })

  it('a no-op transaction resolves immediately without appending', async () => {
    const { identity, adapter, handle, space, docLogStore } = await setup()
    cleanup.push(async () => { handle.close(); await adapter.stop(); await identity.deleteStoredIdentity() })
    const seqBefore = (await docLogStore.getKnownHeads(space.id))[DEVICE] ?? 0
    await handle.transactDurable!(() => {})
    expect(((await docLogStore.getKnownHeads(space.id))[DEVICE] ?? 0)).toBe(seqBefore)
  })
})
