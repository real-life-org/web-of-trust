import { describe, expect, it } from 'vitest'
import { InMemoryMemberUpdatePendingStore } from '../src/adapters/member-update'
import type { MemberUpdateSignal, SeenMemberUpdateSignal } from '../src/protocol/sync/member-update-disposition'

const SPACE = '11111111-1111-4111-8111-111111111111'
const ADMIN = 'did:key:z6MkAdmin'
const MEMBER = 'did:key:z6MkMember'

function signal(overrides: Partial<MemberUpdateSignal> = {}): MemberUpdateSignal {
  return { spaceId: SPACE, action: 'removed', memberDid: MEMBER, effectiveKeyGeneration: 1, signerDid: ADMIN, ...overrides }
}
function seen(disposition: SeenMemberUpdateSignal['storedDisposition'], overrides: Partial<MemberUpdateSignal> = {}): SeenMemberUpdateSignal {
  return { ...signal(overrides), storedDisposition: disposition }
}

describe('InMemoryMemberUpdatePendingStore', () => {
  it('savePending adds to seen, not future', async () => {
    const store = new InMemoryMemberUpdatePendingStore()
    await store.savePending(seen('store-pending-and-sync'))
    expect(await store.listSeenForSpace(SPACE)).toHaveLength(1)
    expect(await store.listFutureForSpace(SPACE)).toHaveLength(0)
  })

  it('keeps exactly one pending record per tuple regardless of signer (Sync 005 Z.179)', async () => {
    const store = new InMemoryMemberUpdatePendingStore()
    await store.savePending(seen('store-unverified-pending-and-sync'))
    await store.savePending(seen('store-unverified-pending-and-sync')) // exact duplicate
    await store.savePending(seen('store-pending-and-sync', { signerDid: 'did:key:z6MkOther' })) // same tuple, other signer
    expect(await store.listSeenForSpace(SPACE)).toHaveLength(1)
  })

  it('upgradePending lifts the disposition but preserves the original signer provenance', async () => {
    const store = new InMemoryMemberUpdatePendingStore()
    await store.savePending(seen('store-unverified-pending-and-sync')) // signer ADMIN (helper default)
    await store.upgradePending({ ...signal({ signerDid: 'did:key:z6MkUpgrader' }), storedDisposition: 'store-pending-and-sync' })
    const list = await store.listSeenForSpace(SPACE)
    expect(list).toHaveLength(1)
    expect(list[0].storedDisposition).toBe('store-pending-and-sync')
    expect(list[0].signerDid).toBe(ADMIN) // provenance not overwritten
  })

  it('bufferFuture stores separately from seen (no storedDisposition leaks into seen)', async () => {
    const store = new InMemoryMemberUpdatePendingStore()
    await store.bufferFuture(signal({ effectiveKeyGeneration: 5 }))
    expect(await store.listSeenForSpace(SPACE)).toHaveLength(0)
    const future = await store.listFutureForSpace(SPACE)
    expect(future).toHaveLength(1)
    expect('storedDisposition' in future[0]).toBe(false)
  })

  it('resolvePending removes only the matching seen tuple; future untouched', async () => {
    const store = new InMemoryMemberUpdatePendingStore()
    await store.savePending(seen('store-pending-and-sync'))
    await store.bufferFuture(signal({ effectiveKeyGeneration: 5 }))
    await store.resolvePending(SPACE, signal())
    expect(await store.listSeenForSpace(SPACE)).toHaveLength(0)
    expect(await store.listFutureForSpace(SPACE)).toHaveLength(1)
  })

  it('resolveFuture removes only the matching future tuple; seen untouched', async () => {
    const store = new InMemoryMemberUpdatePendingStore()
    await store.savePending(seen('store-pending-and-sync'))
    await store.bufferFuture(signal({ effectiveKeyGeneration: 5 }))
    await store.resolveFuture(SPACE, signal({ effectiveKeyGeneration: 5 }))
    expect(await store.listSeenForSpace(SPACE)).toHaveLength(1)
    expect(await store.listFutureForSpace(SPACE)).toHaveLength(0)
  })

  it('returns defensive copies — mutating results does not affect internal state', async () => {
    const store = new InMemoryMemberUpdatePendingStore()
    await store.savePending(seen('store-pending-and-sync'))
    const list = await store.listSeenForSpace(SPACE)
    ;(list as SeenMemberUpdateSignal[]).push(seen('store-pending-and-sync', { memberDid: 'did:key:zEve' }))
    ;(list[0] as { memberDid: string }).memberDid = 'did:key:zMutated'
    const fresh = await store.listSeenForSpace(SPACE)
    expect(fresh).toHaveLength(1)
    expect(fresh[0].memberDid).toBe(MEMBER)
  })
})
