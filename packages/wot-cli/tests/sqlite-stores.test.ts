import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { SqliteCompactStore } from '../src/storage/SqliteCompactStore.js'
import { SqliteKeyValueStore } from '../src/storage/SqliteKeyValueStore.js'
import { SqliteOutboxStore } from '../src/storage/SqliteOutboxStore.js'
import type { MessageEnvelope } from '@real-life/wot-core'

// All tests use in-memory SQLite (no files to clean up)

describe('SqliteCompactStore', () => {
  let store: SqliteCompactStore

  beforeEach(() => { store = new SqliteCompactStore(':memory:') })
  afterEach(() => { store.close() })

  it('save and load a snapshot', async () => {
    const data = new Uint8Array([1, 2, 3, 4, 5])
    await store.save('doc-1', data)

    const loaded = await store.load('doc-1')
    expect(loaded).toEqual(data)
  })

  it('returns null for missing doc', async () => {
    expect(await store.load('nonexistent')).toBeNull()
  })

  it('overwrites existing snapshot', async () => {
    await store.save('doc-1', new Uint8Array([1, 2, 3]))
    await store.save('doc-1', new Uint8Array([4, 5, 6]))

    const loaded = await store.load('doc-1')
    expect(loaded).toEqual(new Uint8Array([4, 5, 6]))
  })

  it('lists all doc IDs', async () => {
    await store.save('a', new Uint8Array([1]))
    await store.save('b', new Uint8Array([2]))
    await store.save('c', new Uint8Array([3]))

    const ids = await store.list()
    expect(ids.sort()).toEqual(['a', 'b', 'c'])
  })

  it('deletes a snapshot', async () => {
    await store.save('doc-1', new Uint8Array([1]))
    await store.delete('doc-1')

    expect(await store.load('doc-1')).toBeNull()
    expect(store.has('doc-1')).toBe(false)
  })

  it('reports size correctly', async () => {
    await store.save('doc-1', new Uint8Array(100))
    expect(store.size('doc-1')).toBe(100)
    expect(store.size('nonexistent')).toBe(0)
  })
})

describe('SqliteKeyValueStore', () => {
  let store: SqliteKeyValueStore

  beforeEach(() => { store = new SqliteKeyValueStore(':memory:') })
  afterEach(() => { store.close() })

  it('set and get a value', async () => {
    await store.set('key-1', { name: 'Eli', role: 'AI' })
    const value = await store.get<{ name: string; role: string }>('key-1')
    expect(value).toEqual({ name: 'Eli', role: 'AI' })
  })

  it('returns null for missing key', async () => {
    expect(await store.get('nonexistent')).toBeNull()
  })

  it('overwrites existing value', async () => {
    await store.set('key', 'first')
    await store.set('key', 'second')
    expect(await store.get('key')).toBe('second')
  })

  it('deletes a key', async () => {
    await store.set('key', 'value')
    await store.delete('key')
    expect(await store.get('key')).toBeNull()
  })

  it('checks has()', async () => {
    expect(await store.has('key')).toBe(false)
    await store.set('key', 'value')
    expect(await store.has('key')).toBe(true)
  })

  it('getByPrefix returns matching entries', async () => {
    await store.set('outbox::1', { msg: 'a' })
    await store.set('outbox::2', { msg: 'b' })
    await store.set('cache::1', { profile: 'x' })

    const outbox = await store.getByPrefix<{ msg: string }>('outbox::')
    expect(outbox).toHaveLength(2)
    expect(outbox.map((e) => e.value.msg).sort()).toEqual(['a', 'b'])
  })

  it('deleteByPrefix removes matching entries', async () => {
    await store.set('outbox::1', 'a')
    await store.set('outbox::2', 'b')
    await store.set('cache::1', 'x')

    await store.deleteByPrefix('outbox::')
    expect(await store.has('outbox::1')).toBe(false)
    expect(await store.has('cache::1')).toBe(true)
  })

  it('clear removes everything', async () => {
    await store.set('a', 1)
    await store.set('b', 2)
    await store.clear()
    expect(await store.get('a')).toBeNull()
    expect(await store.get('b')).toBeNull()
  })
})

function createEnvelope(id: string): MessageEnvelope {
  return {
    v: 1,
    id,
    type: 'attestation',
    fromDid: 'did:key:alice',
    toDid: 'did:key:bob',
    createdAt: new Date().toISOString(),
    encoding: 'json',
    payload: '{}',
    signature: 'sig',
  }
}

describe('SqliteOutboxStore', () => {
  let store: SqliteOutboxStore

  beforeEach(() => { store = new SqliteOutboxStore(':memory:') })
  afterEach(() => { store.close() })

  it('enqueue and getPending', async () => {
    await store.enqueue(createEnvelope('msg-1'))
    await store.enqueue(createEnvelope('msg-2'))

    const pending = await store.getPending()
    expect(pending).toHaveLength(2)
    expect(pending[0].envelope.id).toBe('msg-1')
    expect(pending[0].retryCount).toBe(0)
  })

  it('enqueue is idempotent', async () => {
    const env = createEnvelope('msg-1')
    await store.enqueue(env)
    await store.enqueue(env)

    expect(await store.count()).toBe(1)
  })

  it('dequeue removes entry', async () => {
    await store.enqueue(createEnvelope('msg-1'))
    await store.dequeue('msg-1')

    expect(await store.count()).toBe(0)
    expect(await store.has('msg-1')).toBe(false)
  })

  it('has() checks existence', async () => {
    expect(await store.has('msg-1')).toBe(false)
    await store.enqueue(createEnvelope('msg-1'))
    expect(await store.has('msg-1')).toBe(true)
  })

  it('incrementRetry increases count', async () => {
    await store.enqueue(createEnvelope('msg-1'))
    await store.incrementRetry('msg-1')
    await store.incrementRetry('msg-1')

    const pending = await store.getPending()
    expect(pending[0].retryCount).toBe(2)
  })

  it('count returns correct number', async () => {
    expect(await store.count()).toBe(0)
    await store.enqueue(createEnvelope('msg-1'))
    await store.enqueue(createEnvelope('msg-2'))
    expect(await store.count()).toBe(2)
    await store.dequeue('msg-1')
    expect(await store.count()).toBe(1)
  })

  it('getPending orders by createdAt ascending', async () => {
    const env1 = createEnvelope('msg-1')
    const env2 = createEnvelope('msg-2')

    await store.enqueue(env1)
    // Small delay to ensure different timestamps
    await store.enqueue(env2)

    const pending = await store.getPending()
    expect(pending[0].envelope.id).toBe('msg-1')
    expect(pending[1].envelope.id).toBe('msg-2')
  })
})
