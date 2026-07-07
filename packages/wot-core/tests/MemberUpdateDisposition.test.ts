import { describe, expect, it } from 'vitest'
import { evaluateMemberUpdateDisposition } from '../src/protocol'
import type {
  EvaluateMemberUpdateDispositionInput,
  MemberUpdateSignal,
  SeenMemberUpdateSignal,
} from '../src/protocol'

const SPACE_ID = '7f3a2b10-4c5d-4e6f-8a7b-9c0d1e2f3a4b'
const ADMIN_DID = 'did:key:z6Mkadmin'
const OTHER_ADMIN_DID = 'did:key:z6Mkotheradmin'
const MEMBER_DID = 'did:key:z6Mkmember'
const MEMBER_SIGNER_DID = 'did:key:z6Mkmembersigner'
const UNKNOWN_DID = 'did:key:z6Mkunknown'

function update(overrides: Partial<MemberUpdateSignal> = {}): MemberUpdateSignal {
  return {
    spaceId: SPACE_ID,
    action: 'added',
    memberDid: MEMBER_DID,
    effectiveKeyGeneration: 4,
    signerDid: ADMIN_DID,
    ...overrides,
  }
}

function seen(overrides: Partial<SeenMemberUpdateSignal> = {}): SeenMemberUpdateSignal {
  return {
    ...update(),
    storedDisposition: 'store-pending-and-sync',
    ...overrides,
  }
}

function evaluate(
  incomingUpdate: MemberUpdateSignal,
  overrides: Partial<Omit<EvaluateMemberUpdateDispositionInput, 'incomingUpdate'>> = {},
) {
  return evaluateMemberUpdateDisposition({
    localKeyGeneration: 4,
    knownAdminDids: [ADMIN_DID, OTHER_ADMIN_DID],
    knownMemberDids: [MEMBER_SIGNER_DID],
    seenUpdates: [],
    incomingUpdate,
    ...overrides,
  })
}

describe('member-update disposition invariants', () => {
  it('upgrades an unverified pending tuple when an authorized signer repeats it', () => {
    const tuple = update({ signerDid: UNKNOWN_DID })

    expect(evaluate(update(), {
      seenUpdates: [
        seen({
          ...tuple,
          storedDisposition: 'store-unverified-pending-and-sync',
        }),
      ],
    })).toBe('upgrade-pending-and-sync')
  })

  it('does not downgrade an authorized pending tuple when an unauthorized signer repeats it', () => {
    expect(evaluate(update({ signerDid: UNKNOWN_DID }), {
      seenUpdates: [seen()],
    })).toBe('ignore-lower-authority')
  })

  it('treats same space/action/member/generation as duplicate regardless of signer DID', () => {
    expect(evaluate(update({ signerDid: OTHER_ADMIN_DID }), {
      seenUpdates: [seen()],
    })).toBe('ignore-duplicate')
  })

  it('does not collapse distinct member-update tuples as duplicates', () => {
    expect(evaluate(update({ action: 'removed' }), {
      seenUpdates: [seen()],
    })).toBe('store-pending-and-sync')
  })

  it('ignores stale updates before considering authority or pending duplicates', () => {
    expect(evaluate(update({ effectiveKeyGeneration: 3, signerDid: UNKNOWN_DID }), {
      seenUpdates: [
        seen({
          effectiveKeyGeneration: 3,
          signerDid: UNKNOWN_DID,
          storedDisposition: 'store-unverified-pending-and-sync',
        }),
      ],
    })).toBe('ignore-stale')
  })

  it('buffers future updates that skip beyond the next key generation', () => {
    expect(evaluate(update({ effectiveKeyGeneration: 6 }))).toBe('buffer-future-and-catch-up')
  })

  it('accepts member-signed additions but not member-signed removals as authorized', () => {
    expect(evaluate(update({ action: 'added', signerDid: MEMBER_SIGNER_DID }))).toBe('store-pending-and-sync')
    expect(evaluate(update({ action: 'removed', signerDid: MEMBER_SIGNER_DID }))).toBe(
      'store-unverified-pending-and-sync',
    )
  })
})
