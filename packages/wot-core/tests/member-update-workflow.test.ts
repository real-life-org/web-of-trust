import { describe, expect, it } from 'vitest'
import { processMemberUpdate, type LocalMemberUpdatePolicy } from '../src/application/spaces/member-update-workflow'
import { InMemoryMemberUpdatePendingStore } from '../src/adapters/member-update'
import type { MemberUpdateSignal } from '../src/protocol/sync/member-update-disposition'

const SPACE = '11111111-1111-4111-8111-111111111111'
const ADMIN = 'did:key:z6MkAdmin'
const MEMBER = 'did:key:z6MkMember'
const STRANGER = 'did:key:z6MkStranger'
const LOCAL = 'did:key:z6MkLocal'

function signal(overrides: Partial<MemberUpdateSignal> = {}): MemberUpdateSignal {
  return { spaceId: SPACE, action: 'removed', memberDid: MEMBER, effectiveKeyGeneration: 1, signerDid: ADMIN, ...overrides }
}
function policy(overrides: Partial<LocalMemberUpdatePolicy> = {}): LocalMemberUpdatePolicy {
  return { localKeyGeneration: 1, knownAdminDids: [ADMIN], knownMemberDids: [ADMIN, MEMBER], seenUpdates: [], ...overrides }
}

describe('processMemberUpdate (7 dispositions + Tuple-Merge)', () => {
  it('1. store-pending-and-sync: admin signer, new tuple', async () => {
    const store = new InMemoryMemberUpdatePendingStore()
    const result = await processMemberUpdate({ signal: signal(), policy: policy(), store, localDid: LOCAL })
    expect(result.disposition).toBe('store-pending-and-sync')
    expect(result.triggerSpaceCatchUp).toBe(true)
    expect(result.ackable).toBe(true)
    expect(result.localImpact).toBe('none') // memberDid != localDid
    expect(await store.listSeenForSpace(SPACE)).toHaveLength(1)
  })

  it('2. store-unverified-pending-and-sync: unknown signer', async () => {
    const store = new InMemoryMemberUpdatePendingStore()
    const result = await processMemberUpdate({ signal: signal({ signerDid: STRANGER }), policy: policy(), store, localDid: LOCAL })
    expect(result.disposition).toBe('store-unverified-pending-and-sync')
    expect(result.triggerSpaceCatchUp).toBe(true)
    const seen = await store.listSeenForSpace(SPACE)
    expect(seen[0].storedDisposition).toBe('store-unverified-pending-and-sync')
  })

  it('3. upgrade-pending-and-sync: unverified tuple later signed by admin', async () => {
    const store = new InMemoryMemberUpdatePendingStore()
    await store.savePending({ ...signal({ signerDid: STRANGER }), storedDisposition: 'store-unverified-pending-and-sync' })
    const result = await processMemberUpdate({
      signal: signal({ signerDid: ADMIN }),
      policy: policy({ seenUpdates: await store.listSeenForSpace(SPACE) }),
      store, localDid: LOCAL,
    })
    expect(result.disposition).toBe('upgrade-pending-and-sync')
    const seen = await store.listSeenForSpace(SPACE)
    expect(seen).toHaveLength(1)
    expect(seen[0].storedDisposition).toBe('store-pending-and-sync')
  })

  it('4. ignore-lower-authority: signed pending, lower-authority retry', async () => {
    const store = new InMemoryMemberUpdatePendingStore()
    await store.savePending({ ...signal({ signerDid: ADMIN }), storedDisposition: 'store-pending-and-sync' })
    const result = await processMemberUpdate({
      signal: signal({ signerDid: STRANGER }),
      policy: policy({ seenUpdates: await store.listSeenForSpace(SPACE) }),
      store, localDid: LOCAL,
    })
    expect(result.disposition).toBe('ignore-lower-authority')
    expect(result.triggerSpaceCatchUp).toBe(false)
    const seen = await store.listSeenForSpace(SPACE)
    expect(seen[0].storedDisposition).toBe('store-pending-and-sync') // unchanged
  })

  it('5. ignore-duplicate: same tuple + same authority', async () => {
    const store = new InMemoryMemberUpdatePendingStore()
    await store.savePending({ ...signal({ signerDid: ADMIN }), storedDisposition: 'store-pending-and-sync' })
    const result = await processMemberUpdate({
      signal: signal({ signerDid: ADMIN }),
      policy: policy({ seenUpdates: await store.listSeenForSpace(SPACE) }),
      store, localDid: LOCAL,
    })
    expect(result.disposition).toBe('ignore-duplicate')
    expect(result.triggerSpaceCatchUp).toBe(false)
    expect(await store.listSeenForSpace(SPACE)).toHaveLength(1)
  })

  it('6. ignore-stale: incoming generation below local', async () => {
    const store = new InMemoryMemberUpdatePendingStore()
    const result = await processMemberUpdate({
      signal: signal({ effectiveKeyGeneration: 0 }),
      policy: policy({ localKeyGeneration: 1 }),
      store, localDid: LOCAL,
    })
    expect(result.disposition).toBe('ignore-stale')
    expect(result.triggerSpaceCatchUp).toBe(false)
    expect(await store.listSeenForSpace(SPACE)).toHaveLength(0)
  })

  it('7. buffer-future-and-catch-up: incoming generation beyond local+1', async () => {
    const store = new InMemoryMemberUpdatePendingStore()
    const result = await processMemberUpdate({
      signal: signal({ effectiveKeyGeneration: 5, memberDid: LOCAL }),
      policy: policy({ localKeyGeneration: 1 }),
      store, localDid: LOCAL,
    })
    expect(result.disposition).toBe('buffer-future-and-catch-up')
    expect(result.triggerSpaceCatchUp).toBe(true)
    expect(result.localImpact).toBe('none') // future has no local UX impact (Sync 005 Z.205)
    expect(await store.listFutureForSpace(SPACE)).toHaveLength(1)
    expect(await store.listSeenForSpace(SPACE)).toHaveLength(0)
  })

  it('8. Tuple-Merge (Z.179): re-applying the same tuple+signer+authority is ignored without state change', async () => {
    const store = new InMemoryMemberUpdatePendingStore()
    await processMemberUpdate({ signal: signal(), policy: policy(), store, localDid: LOCAL })
    const second = await processMemberUpdate({
      signal: signal(),
      policy: policy({ seenUpdates: await store.listSeenForSpace(SPACE) }),
      store, localDid: LOCAL,
    })
    expect(second.disposition).toBe('ignore-duplicate')
    expect(await store.listSeenForSpace(SPACE)).toHaveLength(1)
  })

  it('9. No downgrade (Z.179): a signed pending is not overwritten by a lower-authority signal', async () => {
    const store = new InMemoryMemberUpdatePendingStore()
    await store.savePending({ ...signal({ signerDid: ADMIN }), storedDisposition: 'store-pending-and-sync' })
    const before = await store.listSeenForSpace(SPACE)
    const result = await processMemberUpdate({
      signal: signal({ signerDid: STRANGER }),
      policy: policy({ seenUpdates: before }),
      store, localDid: LOCAL,
    })
    expect(result.disposition).toBe('ignore-lower-authority')
    expect(await store.listSeenForSpace(SPACE)).toEqual(before)
  })

  it('localImpact mark-removal-pending when the local DID is the removed authorized member', async () => {
    const store = new InMemoryMemberUpdatePendingStore()
    const result = await processMemberUpdate({
      signal: signal({ memberDid: LOCAL, signerDid: ADMIN }),
      policy: policy(), store, localDid: LOCAL,
    })
    expect(result.disposition).toBe('store-pending-and-sync')
    expect(result.localImpact).toBe('mark-removal-pending')
  })

  it('localImpact mark-addition-pending when the local DID is the added authorized member', async () => {
    const store = new InMemoryMemberUpdatePendingStore()
    const result = await processMemberUpdate({
      signal: signal({ action: 'added', memberDid: LOCAL, signerDid: ADMIN }),
      policy: policy(), store, localDid: LOCAL,
    })
    expect(result.disposition).toBe('store-pending-and-sync')
    expect(result.localImpact).toBe('mark-addition-pending')
  })
})
