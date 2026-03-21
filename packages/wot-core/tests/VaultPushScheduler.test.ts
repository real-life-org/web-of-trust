import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { VaultPushScheduler } from '../src/services/VaultPushScheduler'

describe('VaultPushScheduler', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  function createScheduler(overrides?: {
    pushFn?: () => Promise<void>
    getHeadsFn?: () => string | null
    debounceMs?: number
  }) {
    const pushFn = overrides?.pushFn ?? vi.fn().mockResolvedValue(undefined)
    let heads = 'head-1'
    const getHeadsFn = overrides?.getHeadsFn ?? (() => heads)
    const setHeads = (h: string) => { heads = h }

    const scheduler = new VaultPushScheduler({
      pushFn,
      getHeadsFn,
      debounceMs: overrides?.debounceMs ?? 5000,
    })

    return { scheduler, pushFn: pushFn as ReturnType<typeof vi.fn>, getHeadsFn, setHeads }
  }

  describe('pushImmediate', () => {
    it('should call pushFn immediately', async () => {
      const { scheduler, pushFn } = createScheduler()

      scheduler.pushImmediate()
      await vi.advanceTimersByTimeAsync(0)

      expect(pushFn).toHaveBeenCalledTimes(1)
      scheduler.destroy()
    })

    it('should skip push if heads unchanged (dirty check)', async () => {
      const { scheduler, pushFn } = createScheduler()
      scheduler.setLastPushedHeads('head-1')

      scheduler.pushImmediate()
      await vi.advanceTimersByTimeAsync(0)

      expect(pushFn).not.toHaveBeenCalled()
      scheduler.destroy()
    })

    it('should push if heads changed', async () => {
      const { scheduler, pushFn, setHeads } = createScheduler()
      scheduler.setLastPushedHeads('head-old')
      setHeads('head-new')

      scheduler.pushImmediate()
      await vi.advanceTimersByTimeAsync(0)

      expect(pushFn).toHaveBeenCalledTimes(1)
      scheduler.destroy()
    })

    it('should update lastPushedHeads after successful push', async () => {
      const { scheduler, pushFn } = createScheduler()

      scheduler.pushImmediate()
      await vi.advanceTimersByTimeAsync(0)
      expect(pushFn).toHaveBeenCalledTimes(1)

      // Second push with same heads — should skip
      scheduler.pushImmediate()
      await vi.advanceTimersByTimeAsync(0)
      expect(pushFn).toHaveBeenCalledTimes(1)

      scheduler.destroy()
    })

    it('should not update lastPushedHeads after failed push', async () => {
      const pushFn = vi.fn().mockRejectedValueOnce(new Error('network')).mockResolvedValue(undefined)
      const { scheduler } = createScheduler({ pushFn })

      scheduler.pushImmediate()
      await vi.advanceTimersByTimeAsync(0)
      expect(pushFn).toHaveBeenCalledTimes(1)

      // Should retry because heads weren't marked as pushed
      scheduler.pushImmediate()
      await vi.advanceTimersByTimeAsync(0)
      expect(pushFn).toHaveBeenCalledTimes(2)

      scheduler.destroy()
    })
  })

  describe('pushDebounced', () => {
    it('should wait for debounce delay before pushing', async () => {
      const { scheduler, pushFn } = createScheduler({ debounceMs: 3000 })

      scheduler.pushDebounced()
      await vi.advanceTimersByTimeAsync(2000)
      expect(pushFn).not.toHaveBeenCalled()

      await vi.advanceTimersByTimeAsync(1000)
      expect(pushFn).toHaveBeenCalledTimes(1)

      scheduler.destroy()
    })

    it('should reset debounce timer on repeated calls', async () => {
      const { scheduler, pushFn } = createScheduler({ debounceMs: 3000 })

      scheduler.pushDebounced()
      await vi.advanceTimersByTimeAsync(2000)
      scheduler.pushDebounced() // reset
      await vi.advanceTimersByTimeAsync(2000)
      expect(pushFn).not.toHaveBeenCalled()

      await vi.advanceTimersByTimeAsync(1000)
      expect(pushFn).toHaveBeenCalledTimes(1)

      scheduler.destroy()
    })

    it('should apply dirty check', async () => {
      const { scheduler, pushFn } = createScheduler({ debounceMs: 1000 })
      scheduler.setLastPushedHeads('head-1')

      scheduler.pushDebounced()
      await vi.advanceTimersByTimeAsync(1000)

      expect(pushFn).not.toHaveBeenCalled()
      scheduler.destroy()
    })
  })

  describe('in-flight deduplication', () => {
    it('should queue at most one follow-up push during in-flight push', async () => {
      let resolveFirst!: () => void
      const pushFn = vi.fn()
        .mockImplementationOnce(() => new Promise<void>(r => { resolveFirst = r }))
        .mockResolvedValue(undefined)

      let callCount = 0
      const { scheduler } = createScheduler({
        pushFn,
        getHeadsFn: () => `head-${++callCount}`, // always dirty
      })

      // Start first push (hangs)
      scheduler.pushImmediate()
      await vi.advanceTimersByTimeAsync(0)
      expect(pushFn).toHaveBeenCalledTimes(1)

      // These should all collapse into one pending push
      scheduler.pushImmediate()
      scheduler.pushImmediate()
      scheduler.pushImmediate()

      // Resolve first push
      resolveFirst()
      await vi.advanceTimersByTimeAsync(0)

      // Should have done exactly 2 pushes total (first + one follow-up)
      expect(pushFn).toHaveBeenCalledTimes(2)

      scheduler.destroy()
    })
  })

  describe('flush', () => {
    it('should execute pending debounced push immediately', async () => {
      const { scheduler, pushFn } = createScheduler({ debounceMs: 5000 })

      scheduler.pushDebounced()
      await vi.advanceTimersByTimeAsync(1000) // only 1s of 5s elapsed
      expect(pushFn).not.toHaveBeenCalled()

      scheduler.flush()
      await vi.advanceTimersByTimeAsync(0)
      expect(pushFn).toHaveBeenCalledTimes(1)

      scheduler.destroy()
    })

    it('should do nothing if no pending debounce', async () => {
      const { scheduler, pushFn } = createScheduler()

      scheduler.flush()
      await vi.advanceTimersByTimeAsync(0)

      expect(pushFn).not.toHaveBeenCalled()
      scheduler.destroy()
    })
  })

  describe('pushImmediate cancels pending debounce', () => {
    it('should cancel debounce and push immediately', async () => {
      const { scheduler, pushFn } = createScheduler({ debounceMs: 5000 })

      scheduler.pushDebounced()
      await vi.advanceTimersByTimeAsync(2000)
      expect(pushFn).not.toHaveBeenCalled()

      scheduler.pushImmediate()
      await vi.advanceTimersByTimeAsync(0)
      expect(pushFn).toHaveBeenCalledTimes(1)

      // Debounce should not fire again
      await vi.advanceTimersByTimeAsync(5000)
      expect(pushFn).toHaveBeenCalledTimes(1)

      scheduler.destroy()
    })
  })

  describe('destroy', () => {
    it('should cancel pending debounce', async () => {
      const { scheduler, pushFn } = createScheduler({ debounceMs: 1000 })

      scheduler.pushDebounced()
      scheduler.destroy()
      await vi.advanceTimersByTimeAsync(2000)

      expect(pushFn).not.toHaveBeenCalled()
    })

    it('should ignore calls after destroy', async () => {
      const { scheduler, pushFn } = createScheduler()

      scheduler.destroy()
      scheduler.pushImmediate()
      scheduler.pushDebounced()
      scheduler.flush()
      await vi.advanceTimersByTimeAsync(10000)

      expect(pushFn).not.toHaveBeenCalled()
    })
  })

  describe('getHeadsFn returns null', () => {
    it('should always push when heads are null (no doc yet)', async () => {
      const { scheduler, pushFn } = createScheduler({
        getHeadsFn: () => null,
      })

      scheduler.pushImmediate()
      await vi.advanceTimersByTimeAsync(0)
      expect(pushFn).toHaveBeenCalledTimes(1)

      // null heads → always dirty, should push again
      scheduler.pushImmediate()
      await vi.advanceTimersByTimeAsync(0)
      expect(pushFn).toHaveBeenCalledTimes(2)

      scheduler.destroy()
    })
  })
})
