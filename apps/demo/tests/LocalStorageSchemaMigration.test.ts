import { describe, it, expect, beforeEach, vi } from 'vitest'

const resetMock = vi.fn(async () => {})
vi.mock('../src/services/resetLocalAppData', () => ({
  resetLocalAppData: () => resetMock(),
}))

import {
  runLocalStorageSchemaMigration,
  LOCAL_STORAGE_SCHEMA_VERSION,
} from '../src/services/localStorageSchemaMigration'

const VERSION_KEY = 'wot-storage-schema-version'

describe('runLocalStorageSchemaMigration', () => {
  beforeEach(() => {
    localStorage.clear()
    resetMock.mockClear()
  })

  it('fresh install (no version, no data): records version, no reset', async () => {
    const didReset = await runLocalStorageSchemaMigration()
    expect(didReset).toBe(false)
    expect(resetMock).not.toHaveBeenCalled()
    expect(localStorage.getItem(VERSION_KEY)).toBe(String(LOCAL_STORAGE_SCHEMA_VERSION))
  })

  it('legacy data without version: resets, flags, records version', async () => {
    localStorage.setItem('wot-active-did', 'did:key:zLegacy')
    const didReset = await runLocalStorageSchemaMigration()
    expect(didReset).toBe(true)
    expect(resetMock).toHaveBeenCalledTimes(1)
    expect(localStorage.getItem(VERSION_KEY)).toBe(String(LOCAL_STORAGE_SCHEMA_VERSION))
  })

  it('already at current version: no-op even with data present', async () => {
    localStorage.setItem(VERSION_KEY, String(LOCAL_STORAGE_SCHEMA_VERSION))
    localStorage.setItem('wot-active-did', 'did:key:zX')
    const didReset = await runLocalStorageSchemaMigration()
    expect(didReset).toBe(false)
    expect(resetMock).not.toHaveBeenCalled()
  })

  it('future schema era (marker present, higher value): never breaks — migration, not reset', async () => {
    // Simulates a future format change: the marker exists, so the one-time legacy
    // break must NOT fire again. Future versions migrate instead of wiping.
    localStorage.setItem(VERSION_KEY, '2')
    localStorage.setItem('wot-active-did', 'did:key:zFuture')
    const didReset = await runLocalStorageSchemaMigration()
    expect(didReset).toBe(false)
    expect(resetMock).not.toHaveBeenCalled()
    // Marker is left untouched (a real migration step would advance it deliberately).
    expect(localStorage.getItem(VERSION_KEY)).toBe('2')
  })

  it('is idempotent: second run after migration does nothing', async () => {
    localStorage.setItem('wot-active-did', 'did:key:zLegacy')
    await runLocalStorageSchemaMigration()
    resetMock.mockClear()
    const didReset = await runLocalStorageSchemaMigration()
    expect(didReset).toBe(false)
    expect(resetMock).not.toHaveBeenCalled()
  })
})
