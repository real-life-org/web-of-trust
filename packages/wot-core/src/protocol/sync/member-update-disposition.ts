export type MemberUpdateSignalAction = 'added' | 'removed'

export type MemberUpdateDisposition =
  | 'store-pending-and-sync'
  | 'store-unverified-pending-and-sync'
  | 'upgrade-pending-and-sync'
  | 'ignore-lower-authority'
  | 'ignore-duplicate'
  | 'ignore-stale'
  | 'buffer-future-and-catch-up'

export type StoredMemberUpdateDisposition = 'store-pending-and-sync' | 'store-unverified-pending-and-sync'

export interface MemberUpdateSignal {
  spaceId: string
  action: MemberUpdateSignalAction
  memberDid: string
  effectiveKeyGeneration: number
  signerDid: string
}

export interface SeenMemberUpdateSignal extends MemberUpdateSignal {
  storedDisposition: StoredMemberUpdateDisposition
}

export interface EvaluateMemberUpdateDispositionInput {
  localKeyGeneration: number
  knownAdminDids: readonly string[]
  knownMemberDids: readonly string[]
  seenUpdates: readonly SeenMemberUpdateSignal[]
  incomingUpdate: MemberUpdateSignal
}

export function evaluateMemberUpdateDisposition(input: EvaluateMemberUpdateDispositionInput): MemberUpdateDisposition {
  const incoming = input.incomingUpdate

  if (incoming.effectiveKeyGeneration < input.localKeyGeneration) return 'ignore-stale'
  if (incoming.effectiveKeyGeneration > input.localKeyGeneration + 1) return 'buffer-future-and-catch-up'

  const incomingAuthority = memberUpdateAuthorityLevel(incoming, input)
  const existing = input.seenUpdates.find((seen) => sameMemberUpdateTuple(seen, incoming))
  if (existing) {
    const existingAuthority = storedMemberUpdateAuthorityLevel(existing.storedDisposition)
    if (incomingAuthority > existingAuthority) return 'upgrade-pending-and-sync'
    if (incomingAuthority < existingAuthority) return 'ignore-lower-authority'
    return 'ignore-duplicate'
  }

  return incomingAuthority > 0 ? 'store-pending-and-sync' : 'store-unverified-pending-and-sync'
}

function sameMemberUpdateTuple(left: MemberUpdateSignal, right: MemberUpdateSignal): boolean {
  return left.spaceId === right.spaceId
    && left.action === right.action
    && left.memberDid === right.memberDid
    && left.effectiveKeyGeneration === right.effectiveKeyGeneration
}

function memberUpdateAuthorityLevel(
  update: MemberUpdateSignal,
  input: Pick<EvaluateMemberUpdateDispositionInput, 'knownAdminDids' | 'knownMemberDids'>,
): number {
  if (input.knownAdminDids.includes(update.signerDid)) return 1
  if (update.action === 'added' && input.knownMemberDids.includes(update.signerDid)) return 1
  return 0
}

function storedMemberUpdateAuthorityLevel(disposition: StoredMemberUpdateDisposition): number {
  return disposition === 'store-pending-and-sync' ? 1 : 0
}
