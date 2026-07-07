import 'fake-indexeddb/auto'
import { IDBFactory } from 'fake-indexeddb'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  IndexedDbIdentitySeedVault,
  closeOpenIdentitySeedVaultConnections,
} from '../src/adapters/storage/indexeddb'
import { WebCryptoProtocolCryptoAdapter } from '../src/adapters/protocol-crypto'

// Cluster-B logout fix: an OPEN IndexedDbIdentitySeedVault connection blocks the W2
// whole-DB delete of `wot-identity`, leaving the seed on disk (→ W5 reports "survived" →
// logout hangs). These tests pin the connection lifecycle: the registry-driven
// closeOpenIdentitySeedVaultConnections() deterministically unblocks the delete, close()
// resets one instance, and onversionchange is the hygiene backstop.

const cryptoAdapter = new WebCryptoProtocolCryptoAdapter()
const SEED = () => crypto.getRandomValues(new Uint8Array(64))
const PW = 'pw-12345678'

/** Run deleteDatabase, resolving with whether onsuccess/onerror fired and whether it blocked. */
function deleteDb(name: string): Promise<{ settled: 'success' | 'error'; blocked: boolean }> {
  return new Promise((resolve) => {
    let blocked = false
    const req = indexedDB.deleteDatabase(name)
    req.onblocked = () => {
      blocked = true
    }
    req.onsuccess = () => resolve({ settled: 'success', blocked })
    req.onerror = () => resolve({ settled: 'error', blocked })
  })
}

beforeEach(() => {
  globalThis.indexedDB = new IDBFactory()
})

afterEach(() => {
  // Clear the module-level registry between tests (close any vault left open).
  closeOpenIdentitySeedVaultConnections()
})

describe('IndexedDbIdentitySeedVault — wipe-blocking connection lifecycle', () => {
  it('a non-yielding open connection BLOCKS deleteDatabase(wot-identity) — the failure mode this fixes', async () => {
    // A raw connection WITHOUT an onversionchange handler (the pre-fix behavior): it does
    // not yield, so the whole-DB delete is blocked. Proves the env models the block (so the
    // closeOpen test below is non-vacuous).
    const rawDb = await new Promise<IDBDatabase>((resolve, reject) => {
      const req = indexedDB.open('wot-identity', 2)
      req.onupgradeneeded = () => {
        const db = req.result
        if (!db.objectStoreNames.contains('seeds')) db.createObjectStore('seeds')
        if (!db.objectStoreNames.contains('session')) db.createObjectStore('session')
      }
      req.onsuccess = () => resolve(req.result)
      req.onerror = () => reject(req.error)
    })

    let blocked = false
    let settled = false
    const req = indexedDB.deleteDatabase('wot-identity')
    req.onblocked = () => {
      blocked = true
    }
    req.onsuccess = () => {
      settled = true
    }
    // Give the event loop a few ticks to dispatch versionchange/blocked.
    await new Promise((r) => setTimeout(r, 50))
    expect(blocked).toBe(true) // the open connection blocked the delete
    expect(settled).toBe(false) // ...and the delete did NOT complete while it stayed open

    rawDb.close() // let the now-unblocked delete finish (cleanup)
  })

  it('closeOpenIdentitySeedVaultConnections() unblocks the whole-DB delete and the seed is REALLY gone', async () => {
    const vault = new IndexedDbIdentitySeedVault({ crypto: cryptoAdapter })
    await vault.saveSeed(SEED(), PW) // opens + registers the connection, stores the seed
    expect(await vault.hasSeed()).toBe(true)

    closeOpenIdentitySeedVaultConnections() // the deterministic fix, BEFORE the delete

    const result = await deleteDb('wot-identity')
    expect(result.blocked).toBe(false) // connection was closed → not blocked
    expect(result.settled).toBe('success')

    // The seed is gone: a fresh vault (DB recreated empty on open) sees no seed.
    expect(await new IndexedDbIdentitySeedVault().hasSeed()).toBe(false)
  })

  it('close() closes the live connection and a later operation transparently reopens', async () => {
    const vault = new IndexedDbIdentitySeedVault({ crypto: cryptoAdapter })
    await vault.saveSeed(SEED(), PW)

    vault.close() // closes this.db + unregisters

    // A subsequent op reopens via ensureDb and still works (idempotent close, lazy reopen).
    expect(await vault.hasSeed()).toBe(true)
    // close() again with a fresh connection now open is still safe.
    vault.close()
  })

  it('onversionchange backstop: an open vault connection yields so a competing delete completes even without closeOpen', async () => {
    const vault = new IndexedDbIdentitySeedVault({ crypto: cryptoAdapter })
    await vault.saveSeed(SEED(), PW) // open; ensureDb bound db.onversionchange to this concrete handle

    // Deliberately do NOT call closeOpen — rely solely on the hygiene handler.
    const result = await deleteDb('wot-identity')
    expect(result.settled).toBe('success') // the vault's onversionchange closed it → delete completes
  })

  it('SINGLE-FLIGHT: concurrent first operations share ONE open (no orphan connection for closeOpen to miss)', async () => {
    const vault = new IndexedDbIdentitySeedVault({ crypto: cryptoAdapter })
    const openSpy = vi.spyOn(indexedDB, 'open')

    // Two concurrent FIRST operations race ensureDb(). Without single-flight each opens its own
    // connection (TWO opens); this.db then tracks only the last, so closeOpen() — which closes
    // the instance's this.db — would leave the OTHER connection open: an orphan that keeps
    // blocking deleteDatabase('wot-identity') (Anton's blocker). Counting opens isolates the
    // single-flight guarantee from the onversionchange backstop (which would mask an orphan by
    // closing it on the delete's versionchange).
    await Promise.all([vault.hasSeed(), vault.hasActiveSession()])
    expect(openSpy.mock.calls.filter((c) => c[0] === 'wot-identity').length).toBe(1)

    // ...and closeOpen() then fully clears the single connection, so the delete is unblocked.
    closeOpenIdentitySeedVaultConnections()
    const result = await deleteDb('wot-identity')
    expect(result.settled).toBe('success')

    openSpy.mockRestore()
  })
})
