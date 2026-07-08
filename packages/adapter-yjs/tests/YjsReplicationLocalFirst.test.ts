import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import type { PublicIdentitySession } from '../../wot-core/src/application/identity'
import { createTestIdentity } from '../../wot-core/tests/helpers/identity-session'
import { InMemoryMessagingAdapter, InMemoryKeyManagementAdapter } from '@web_of_trust/core/adapters'
import { YjsReplicationAdapter } from '../src/YjsReplicationAdapter'

// local-first (spec-startup-local-first, TEIL B / Blocker 2): start() used to
// await _pullAllFromVault() — naked vault fetches — and setIsInitialized sat behind
// it, so a dead-but-reachable box hung the spinner for minutes. start() is now
// split: the LOCAL init (restoreSpacesFromMetadata etc.) is awaited, the NETWORK
// vault pull is deferred to pullFromVaultInBackground(), run AFTER first render.

describe('YjsReplicationAdapter — start() vault-pull split (local-first)', () => {
  let alice: PublicIdentitySession
  let messaging: InMemoryMessagingAdapter
  let adapter: YjsReplicationAdapter

  beforeEach(async () => {
    InMemoryMessagingAdapter.resetAll()
    alice = (await createTestIdentity('alice-localfirst')).identity
    messaging = new InMemoryMessagingAdapter()
    await messaging.connect(alice.getDid())
    adapter = new YjsReplicationAdapter({
      identity: alice,
      messaging,
      brokerUrls: ['wss://broker.example.com'],
      keyManagement: new InMemoryKeyManagementAdapter(),
    })
  })

  afterEach(async () => {
    await adapter.stop()
    InMemoryMessagingAdapter.resetAll()
    try { await alice.deleteStoredIdentity() } catch {}
    vi.restoreAllMocks()
  })

  it('start({ skipVaultPull: true }) does NOT touch the network vault path', async () => {
    const pullSpy = vi.spyOn(adapter as never as { _pullAllFromVault: () => Promise<void> }, '_pullAllFromVault').mockResolvedValue()
    const sendSpy = vi.spyOn(adapter as never as { _sendFullStateAllSpaces: () => Promise<void> }, '_sendFullStateAllSpaces').mockResolvedValue()
    const recoverSpy = vi.spyOn(adapter as never as { recoverPendingRemovalsOnce: () => Promise<void> }, 'recoverPendingRemovalsOnce').mockResolvedValue()

    await adapter.start({ skipVaultPull: true })

    // The awaited init stayed LOCAL — none of the deferred network steps ran.
    expect(pullSpy).not.toHaveBeenCalled()
    expect(sendSpy).not.toHaveBeenCalled()
    expect(recoverSpy).not.toHaveBeenCalled()

    // The background job runs exactly the deferred steps, in order.
    await adapter.pullFromVaultInBackground()
    expect(sendSpy).toHaveBeenCalledOnce()
    expect(pullSpy).toHaveBeenCalledOnce()
    expect(recoverSpy).toHaveBeenCalledOnce()
  })

  it('start() without the flag still runs the vault pull inline (backward compatible)', async () => {
    const pullSpy = vi.spyOn(adapter as never as { _pullAllFromVault: () => Promise<void> }, '_pullAllFromVault').mockResolvedValue()

    await adapter.start()

    expect(pullSpy).toHaveBeenCalledOnce()
  })

  it('pullFromVaultInBackground never throws even if the vault pull rejects (dead box)', async () => {
    vi.spyOn(adapter as never as { _sendFullStateAllSpaces: () => Promise<void> }, '_sendFullStateAllSpaces').mockResolvedValue()
    vi.spyOn(adapter as never as { _pullAllFromVault: () => Promise<void> }, '_pullAllFromVault').mockRejectedValue(new Error('box is gone'))

    await adapter.start({ skipVaultPull: true })
    // Must resolve (not reject) — a dead vault must never surface as an init failure.
    await expect(adapter.pullFromVaultInBackground()).resolves.toBeUndefined()
  })
})
