import { describe, expect, it } from 'vitest'
import { InMemoryVerificationStateStore } from '../src/adapters'

describe('InMemoryVerificationStateStore', () => {
  it('stores consumed nonces case-insensitively and prunes records older than a cutoff', async () => {
    const store = new InMemoryVerificationStateStore()

    await store.recordConsumedNonce('550E8400-E29B-41D4-A716-446655440000', '2026-04-28T08:04:59Z')
    await store.recordConsumedNonce('123e4567-e89b-42d3-a456-426614174000', '2026-04-29T08:04:59Z')

    expect(await store.hasConsumedNonce('550e8400-e29b-41d4-a716-446655440000')).toBe(true)
    await store.pruneConsumedNonces('2026-04-29T08:04:59Z')

    expect(await store.hasConsumedNonce('550e8400-e29b-41d4-a716-446655440000')).toBe(false)
    expect(await store.hasConsumedNonce('123e4567-e89b-42d3-a456-426614174000')).toBe(true)
  })

  it('stores, lists, deletes, and prunes pending counter-verification records', async () => {
    const store = new InMemoryVerificationStateStore()
    const pending = {
      counterpartyDid: 'did:key:z6MkpTHR8VNsBxYAAWHut2Geadd9jSwuBV8xRoAnwWsdvktH',
      originalVerificationId: 'urn:uuid:verification-550e8400-e29b-41d4-a716-446655440000-ben',
      createdAt: '2026-04-28T08:04:59Z',
      expiresAt: '2026-04-29T08:04:59Z',
    }

    await store.recordPendingCounterVerification(pending)
    expect(await store.getPendingCounterVerification(pending.originalVerificationId)).toEqual(pending)
    expect(await store.getPendingCounterVerifications()).toEqual([pending])

    await store.prunePendingCounterVerifications('2026-04-29T08:04:58Z')
    expect(await store.getPendingCounterVerification(pending.originalVerificationId)).toEqual(pending)

    await store.prunePendingCounterVerifications('2026-04-29T08:04:59Z')
    expect(await store.getPendingCounterVerification(pending.originalVerificationId)).toBeNull()

    await store.recordPendingCounterVerification(pending)
    await store.deletePendingCounterVerification(pending.originalVerificationId)
    expect(await store.getPendingCounterVerifications()).toEqual([])
  })
})
