/**
 * Tests für das page-lokale Live-Polling der Network-Seite (Beamer-Modus).
 * Fokus: der Interval feuert periodisch UND wird beim Unmount sauber
 * aufgeräumt (kein Timer-Leak).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook } from '@testing-library/react'
import { useGraphLivePolling } from '../src/hooks/useGraphLivePolling'

describe('useGraphLivePolling', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.restoreAllMocks()
    vi.useRealTimers()
  })

  it('force-refreshes on every interval tick while mounted', () => {
    const forceRefresh = vi.fn()
    renderHook(() => useGraphLivePolling(forceRefresh, 10_000))

    expect(forceRefresh).not.toHaveBeenCalled()

    vi.advanceTimersByTime(10_000)
    expect(forceRefresh).toHaveBeenCalledTimes(1)

    vi.advanceTimersByTime(20_000)
    expect(forceRefresh).toHaveBeenCalledTimes(3)
  })

  it('clears the interval on unmount and stops polling (no timer leak)', () => {
    const clearSpy = vi.spyOn(globalThis, 'clearInterval')
    const forceRefresh = vi.fn()
    const { unmount } = renderHook(() => useGraphLivePolling(forceRefresh, 10_000))

    vi.advanceTimersByTime(10_000)
    expect(forceRefresh).toHaveBeenCalledTimes(1)

    unmount()
    expect(clearSpy).toHaveBeenCalled()

    // After unmount the timer must not fire again.
    vi.advanceTimersByTime(60_000)
    expect(forceRefresh).toHaveBeenCalledTimes(1)
  })

  it('swallows rejected force-refresh promises (no unhandled rejection)', async () => {
    const forceRefresh = vi.fn(async () => { throw new Error('network down') })
    renderHook(() => useGraphLivePolling(forceRefresh, 5_000))

    vi.advanceTimersByTime(5_000)
    expect(forceRefresh).toHaveBeenCalledTimes(1)
    // Let the rejected microtask settle — `void forceRefresh()` must not throw.
    await Promise.resolve()
  })
})
