import { describe, it, expect, vi, afterEach } from 'vitest'
import { probeStorage } from './storage-guard'

/**
 * #274/#275 — probeStorage() gates the whole app before React touches any
 * IndexedDB adapter. On iOS Lockdown Mode / "Block All Cookies" the durable
 * store is unusable (`indexedDB` missing, `localStorage.setItem` throws) and the
 * old raw "Can't find variable: indexedDB" crash must be replaced by the
 * friendly blocked screen. Storage counts as OK only when BOTH backends work.
 */

/** A fake indexedDB whose open() fires onsuccess on the next microtask. */
function stubIndexedDBSuccess() {
  const close = vi.fn()
  const deleteDatabase = vi.fn()
  const open = vi.fn(() => {
    const req: {
      onsuccess?: () => void
      onerror?: () => void
      onblocked?: () => void
      result: { close: () => void }
    } = { result: { close } }
    // Handlers are assigned synchronously right after open() returns, so fire
    // onsuccess on the next microtask.
    queueMicrotask(() => req.onsuccess?.())
    return req
  })
  vi.stubGlobal('indexedDB', { open, deleteDatabase })
  return { open, deleteDatabase, close }
}

function stubLocalStorageWorking() {
  const store = new Map<string, string>()
  vi.stubGlobal('localStorage', {
    setItem: vi.fn((k: string, v: string) => void store.set(k, v)),
    removeItem: vi.fn((k: string) => void store.delete(k)),
  })
}

describe('probeStorage (#274/#275 — fail-closed storage guard)', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('(a) returns false when indexedDB is undefined (iOS Lockdown / Private)', async () => {
    vi.stubGlobal('indexedDB', undefined)
    stubLocalStorageWorking()
    await expect(probeStorage()).resolves.toBe(false)
  })

  it('(b) returns false when localStorage.setItem throws (Block All Cookies)', async () => {
    stubIndexedDBSuccess()
    vi.stubGlobal('localStorage', {
      setItem: vi.fn(() => {
        throw new Error('QuotaExceededError: cookies blocked')
      }),
      removeItem: vi.fn(),
    })
    await expect(probeStorage()).resolves.toBe(false)
  })

  it('(c) returns true when indexedDB.open succeeds AND localStorage works', async () => {
    const { deleteDatabase, close } = stubIndexedDBSuccess()
    stubLocalStorageWorking()
    await expect(probeStorage()).resolves.toBe(true)
    // On success the probe DB is closed and best-effort deleted.
    expect(close).toHaveBeenCalled()
    expect(deleteDatabase).toHaveBeenCalledWith('wot-storage-probe')
  })

  it('never rejects even if indexedDB.open throws synchronously', async () => {
    vi.stubGlobal('indexedDB', {
      open: vi.fn(() => {
        throw new Error('SecurityError')
      }),
      deleteDatabase: vi.fn(),
    })
    stubLocalStorageWorking()
    await expect(probeStorage()).resolves.toBe(false)
  })

  it('(fail-closed) returns false when indexedDB.open hangs past the 4s timeout', async () => {
    vi.useFakeTimers()
    try {
      // open() returns a request whose onsuccess/onerror/onblocked are NEVER
      // fired — a real hang/block. localStorage works, so this exercises the
      // IndexedDB timeout path specifically (not the localStorage branch).
      const reqStub: Record<string, unknown> = {}
      vi.stubGlobal('indexedDB', {
        open: vi.fn(() => reqStub),
        deleteDatabase: vi.fn(),
      })
      stubLocalStorageWorking()

      const p = probeStorage()
      await vi.advanceTimersByTimeAsync(4000)
      expect(await p).toBe(false)
    } finally {
      vi.useRealTimers()
    }
  })
})
