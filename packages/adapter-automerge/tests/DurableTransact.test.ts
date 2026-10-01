import { describe, it, expect, afterEach } from 'vitest'
import { createTestIdentity } from '../../wot-core/tests/helpers/identity-session'
import {
  InMemoryMessagingAdapter,
  InProcessLogBroker,
  InMemorySpaceMetadataStorage,
  InMemoryKeyManagementAdapter,
  InMemoryDocLogStore,
} from '@web_of_trust/core/adapters'
import type { AppendLocalEntryParams } from '@web_of_trust/core/ports'
import { AutomergeReplicationAdapter } from '../src/AutomergeReplicationAdapter'
import { InMemoryRepoStorageAdapter } from '../src/InMemoryRepoStorageAdapter'

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
  const { identity } = await createTestIdentity('am-durable-transact')
  const messaging = new InMemoryMessagingAdapter({ broker, socketId: 'am-durable-transact' })
  await messaging.connect(identity.getDid())
  const docLogStore = new InMemoryDocLogStore()
  await docLogStore.init()
  await docLogStore.setDeviceId(DEVICE)
  const gate = gateableStore(docLogStore)
  const keyManagement = new InMemoryKeyManagementAdapter()
  const adapter = new AutomergeReplicationAdapter({
    identity, messaging, brokerUrls: BROKER_URLS,
    keyManagement,
    metadataStorage: new InMemorySpaceMetadataStorage(),
    repoStorage: new InMemoryRepoStorageAdapter(),
    docLogStore, deviceId: DEVICE,
  })
  await adapter.start()
  const space = await adapter.createSpace<TestDoc>('shared', { items: {} }, { name: 'Durable' })
  const handle = await adapter.openSpace<TestDoc>(space.id)
  return { identity, adapter, handle, space, docLogStore, gate, keyManagement }
}

// Parity with adapter-yjs/tests/DurableTransact.test.ts — the transaction-bound
// durability contract must hold identically for the Automerge engine.
describe('SpaceHandle.transactDurable — Automerge', () => {
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

    handle.transact((doc) => { doc.items['foreign'] = { title: 'other' } })
    await waitUntil(async () => ((await docLogStore.getKnownHeads(space.id))[DEVICE] ?? 0) > seqBefore, 'the foreign append')
    await new Promise((r) => setTimeout(r, 50))
    expect(settled).toBe(false) // head moved, gate still closed — the ack is transaction-bound

    gate.release()
    await durable
    expect(settled).toBe(true)
    expect((handle.getDoc() as TestDoc).items['durable'].title).toBe('mine')
  })

  it('rejects when the append of its transaction fails', async () => {
    const { identity, adapter, handle, space, gate } = await setup()
    cleanup.push(async () => { handle.close(); await adapter.stop(); await identity.deleteStoredIdentity() })
    gate.failNext(space.id)
    await expect(handle.transactDurable!((doc) => { doc.items['x'] = { title: 'x' } })).rejects.toThrow(/injected append failure/)
  })

  it('rejects fail-closed when no content key is available (append silently skipped)', async () => {
    const { identity, adapter, handle, keyManagement } = await setup()
    cleanup.push(async () => { handle.close(); await adapter.stop(); await identity.deleteStoredIdentity() })
    keyManagement.getKeyByGeneration = async () => null
    await expect(handle.transactDurable!((doc) => { doc.items['x'] = { title: 'x' } })).rejects.toThrow(/no content key/)
  })

  it('a failed append followed by the SAME re-set yields a NEW confirmed append (the #192 retry contract)', async () => {
    const { identity, adapter, handle, space, docLogStore, gate } = await setup()
    cleanup.push(async () => { handle.close(); await adapter.stop(); await identity.deleteStoredIdentity() })

    gate.failNext(space.id)
    await expect(handle.transactDurable!((doc) => { doc.items['m'] = { title: 'Precious' } })).rejects.toThrow(/injected append failure/)
    expect((handle.getDoc() as TestDoc).items['m'].title).toBe('Precious')
    const seqAfterFailure = (await docLogStore.getKnownHeads(space.id))[DEVICE] ?? 0

    await handle.transactDurable!((doc) => { doc.items['m'] = { title: 'Precious' } })
    const seqAfterRetry = (await docLogStore.getKnownHeads(space.id))[DEVICE] ?? 0
    expect(seqAfterRetry).toBeGreaterThan(seqAfterFailure)
  })

  it('does not swallow remote-update notifications while its own append is in flight', async () => {
    // Reviewer repro: localChanging may only cover the synchronous own change.
    const { identity, adapter, handle, space, gate } = await setup()
    cleanup.push(async () => { handle.close(); await adapter.stop(); await identity.deleteStoredIdentity() })

    let remoteNotified = 0
    handle.onRemoteUpdate(() => { remoteNotified += 1 })

    gate.arm(space.id)
    const durable = handle.transactDurable!((doc) => { doc.items['durable'] = { title: 'mine' } })

    // While the append is gated, a change arrives OUTSIDE the handle (as a remote
    // apply does): the notification MUST fire before the gate is released.
    const internals = adapter as unknown as { spaces: Map<string, { documentId: string }>; repo: { handles: Record<string, { change: (fn: (d: TestDoc) => void) => void }> } }
    const docHandle = internals.repo.handles[internals.spaces.get(space.id)!.documentId]
    docHandle.change((d) => { d.items['remote'] = { title: 'from elsewhere' } })
    await waitUntil(() => remoteNotified > 0, 'the remote-update notification during the in-flight append')

    gate.release()
    await durable
  })

  it('a no-op transaction resolves immediately without appending', async () => {
    const { identity, adapter, handle, space, docLogStore } = await setup()
    cleanup.push(async () => { handle.close(); await adapter.stop(); await identity.deleteStoredIdentity() })
    const seqBefore = (await docLogStore.getKnownHeads(space.id))[DEVICE] ?? 0
    await handle.transactDurable!(() => {})
    expect(((await docLogStore.getKnownHeads(space.id))[DEVICE] ?? 0)).toBe(seqBefore)
  })
})
