// @vitest-environment node
// The library's own store contract (storeContract) against the IndexedDB store, plus what the
// contract does not cover: sealed at rest, bound to its database name, sealable per generation.
import { describe, expect, it, test } from 'vitest'
import { IDBFactory } from 'fake-indexeddb'
import { storeContract } from '../../src/adapters/rltp/testing'
import { idbHolderStore } from '../../src/adapters/rltp/store-idb'
import { createSealer } from '../../src/adapters/rltp/sealed'
import { StoreSealedError } from '../../src/adapters/rltp/idb'

const dek = new Uint8Array(32).fill(7)
let n = 0
const make = async (idb = new IDBFactory(), name = 'wot-v3-holder-t', seal = { sealed: false }) =>
  idbHolderStore({ idb, name, sealer: await createSealer(dek), uuid: () => crypto.randomUUID(), seal })

describe('store contract', () => {
  storeContract(() => make(new IDBFactory(), `wot-v3-holder-${++n}`), {
    test: (name, fn) => test(name, fn),
    assert: { equal: (a, b, m) => expect(a, m).toEqual(b), ok: (v, m) => expect(v, m).toBeTruthy() },
  })
})

describe('idb holder store', () => {
  it('keeps the state only sealed and reads it back after reopening', async () => {
    const idb = new IDBFactory()
    const s = await make(idb)
    const r = await s.commit(null, { secret: 'plain text' } as never)
    expect(r.ok).toBe(true)
    s.close()
    const raw = await new Promise<unknown>((resolve) => {
      const o = idb.open('wot-v3-holder-t', 1)
      o.onsuccess = () => {
        const g = o.result.transaction('holder').objectStore('holder').get('state')
        g.onsuccess = () => resolve(g.result)
      }
    })
    expect(JSON.stringify(raw)).not.toContain('plain text')
    const again = await make(idb)
    expect((await again.read()).state).toEqual({ secret: 'plain text' })
  })

  it('a blob does not open under another database name', async () => {
    const idb = new IDBFactory()
    const a = await make(idb, 'wot-v3-holder-a')
    await a.commit(null, { x: 1 } as never)
    a.close()
    // copy the row into another namespace
    await new Promise<void>((resolve) => {
      const o = idb.open('wot-v3-holder-a', 1)
      o.onsuccess = () => {
        const g = o.result.transaction('holder').objectStore('holder').get('state')
        g.onsuccess = () => {
          const row = g.result
          o.result.close()
          const p = idb.open('wot-v3-holder-b', 1)
          p.onupgradeneeded = () => p.result.createObjectStore('holder')
          p.onsuccess = () => {
            const tx = p.result.transaction('holder', 'readwrite')
            tx.objectStore('holder').put(row, 'state')
            tx.oncomplete = () => resolve()
          }
        }
      }
    })
    const b = await make(idb, 'wot-v3-holder-b')
    await expect(b.read()).rejects.toThrow()
  })

  it('after the seal no commit starts', async () => {
    const seal = { sealed: false }
    const s = await make(new IDBFactory(), 'wot-v3-holder-s', seal)
    await s.commit(null, { a: 1 } as never)
    seal.sealed = true
    const { version } = await s.read()
    await expect(s.commit(version, { a: 2 } as never)).rejects.toBeInstanceOf(StoreSealedError)
    expect((await s.read()).state).toEqual({ a: 1 })
  })
})
