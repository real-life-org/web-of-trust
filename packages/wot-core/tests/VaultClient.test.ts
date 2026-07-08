import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { VaultClient } from '../src/adapters/vault/VaultClient'
import { DualVaultClient } from '../src/adapters/vault/DualVaultClient'
import type { VaultChangesResponse } from '../src/adapters/vault/VaultClient'
import { createTestIdentity } from './helpers/identity-session'
import type { PublicIdentitySession } from '../src/application/identity'

// Camp-relevant regression (spec-startup-local-first, TEIL A): a dead-but-reachable
// vault (the festival box on 5G) used to hang the naked fetch() until the OS TCP
// timeout — minutes. VaultClient now wraps every fetch in an AbortController
// timeout backstop (constructor option, default 8000ms). This is ALSO the
// precondition that makes DualVaultClient failover real: getChanges waits on
// Promise.allSettled over ALL targets, so without a per-target abort even a
// reachable server-vault never returns while the box hangs.

const DOC_ID = 'personal-doc'

/** A fetch that never resolves on its own but honours the AbortController signal
 *  (rejecting with an AbortError), exactly like the platform fetch on abort. */
function hangingFetch(): typeof globalThis.fetch {
  return vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
    return new Promise<Response>((_resolve, reject) => {
      const signal = init?.signal
      if (signal) {
        if (signal.aborted) {
          reject(Object.assign(new Error('The operation was aborted'), { name: 'AbortError' }))
          return
        }
        signal.addEventListener('abort', () => {
          reject(Object.assign(new Error('The operation was aborted'), { name: 'AbortError' }))
        })
      }
    })
  }) as unknown as typeof globalThis.fetch
}

function fakeVault(overrides: Partial<Record<string, unknown>> = {}) {
  const empty: VaultChangesResponse = { docId: DOC_ID, snapshot: null, changes: [] }
  return {
    pushChange: vi.fn().mockResolvedValue(1),
    getChanges: vi.fn().mockResolvedValue(empty),
    putSnapshot: vi.fn().mockResolvedValue(undefined),
    getDocInfo: vi.fn().mockResolvedValue(null),
    deleteDoc: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  }
}

describe('VaultClient — timeout backstop (TEIL A)', () => {
  let identity: PublicIdentitySession
  let originalFetch: typeof globalThis.fetch

  beforeEach(async () => {
    identity = (await createTestIdentity('vault-timeout')).identity
    originalFetch = globalThis.fetch
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
    vi.restoreAllMocks()
  })

  it('aborts getChanges after the configured timeout instead of hanging forever', async () => {
    globalThis.fetch = hangingFetch()
    // Short timeout keeps the test fast; the production default is 8000ms.
    const client = new VaultClient('https://box.local', identity, { timeoutMs: 40 })

    const start = Date.now()
    await expect(client.getChanges(DOC_ID)).rejects.toMatchObject({ name: 'AbortError' })
    // Bounded: it must reject on the order of the timeout, not hang.
    expect(Date.now() - start).toBeLessThan(2000)
  })

  it('aborts pushChange after the timeout as well (every fetch is wrapped)', async () => {
    globalThis.fetch = hangingFetch()
    const client = new VaultClient('https://box.local', identity, { timeoutMs: 40 })
    await expect(client.pushChange(DOC_ID, new Uint8Array([1, 2, 3]))).rejects.toMatchObject({
      name: 'AbortError',
    })
  })

  it('makes DualVault failover REAL: a timing-out box primary falls through to the server secondary', async () => {
    globalThis.fetch = hangingFetch()
    const boxPrimary = new VaultClient('https://box.local', identity, { timeoutMs: 40 })
    const serverSecondary = fakeVault({
      getChanges: vi.fn().mockResolvedValue({
        docId: DOC_ID,
        snapshot: { data: 'server-snapshot', upToSeq: 9 },
        changes: [],
      }),
    })
    const dual = new DualVaultClient([boxPrimary, serverSecondary] as never)

    const result = await dual.getChanges(DOC_ID)
    // The box hung, aborted, and the server-vault carried the read.
    expect(result.snapshot).toEqual({ data: 'server-snapshot', upToSeq: 9 })
    expect(serverSecondary.getChanges).toHaveBeenCalledOnce()
  })

  it('a timing-out primary with an empty secondary yields an empty restore, no crash', async () => {
    globalThis.fetch = hangingFetch()
    const boxPrimary = new VaultClient('https://box.local', identity, { timeoutMs: 40 })
    const serverSecondary = fakeVault() // resolves empty
    const dual = new DualVaultClient([boxPrimary, serverSecondary] as never)

    const result = await dual.getChanges(DOC_ID)
    expect(result.snapshot).toBeNull()
    expect(result.changes).toHaveLength(0)
  })
})
