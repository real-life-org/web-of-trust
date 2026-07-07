import {
  evaluateMemberUpdateDisposition,
  type MemberUpdateDisposition,
  type MemberUpdateSignal,
  type SeenMemberUpdateSignal,
} from '../../protocol/sync/member-update-disposition'
import type { MemberUpdatePendingStore } from '../../ports/MemberUpdatePendingStore'

export interface ProcessMemberUpdateOptions {
  signal: MemberUpdateSignal       // (spaceId, action, memberDid, effectiveKeyGeneration, signerDid)
  policy: LocalMemberUpdatePolicy  // (localKeyGeneration, knownAdminDids, knownMemberDids, seenUpdates)
  store: MemberUpdatePendingStore  // durable pending persistence (in-memory default; durable store is an Adapter concern)
  localDid: string                 // needed for localImpact classification
}

/** Tells the adapter which pending UX / write-lock signal to apply locally. */
export type LocalImpact =
  | 'none'
  | 'mark-removal-pending'   // localDid was removed → write-lock + UI "removal pending"
  | 'mark-addition-pending'  // localDid was added → UI "join pending"

export interface ProcessMemberUpdateResult {
  disposition: MemberUpdateDisposition
  triggerSpaceCatchUp: boolean
  ackable: boolean
  localImpact: LocalImpact
}

export interface LocalMemberUpdatePolicy {
  localKeyGeneration: number
  knownAdminDids: readonly string[]
  knownMemberDids: readonly string[]
  seenUpdates: readonly SeenMemberUpdateSignal[]
}

/**
 * Application-layer orchestration for an incoming member-update (Sync 005 Z.169-177).
 * Pure orchestration: classifies via the protocol disposition classifier, persists the
 * pending state durably, and reports the local UX impact. No crypto, no sync trigger,
 * no UI, no canonical state mutation — the adapter owns those decisions.
 */
export async function processMemberUpdate(
  options: ProcessMemberUpdateOptions,
): Promise<ProcessMemberUpdateResult> {
  const disposition = evaluateMemberUpdateDisposition({
    localKeyGeneration: options.policy.localKeyGeneration,
    knownAdminDids: options.policy.knownAdminDids,
    knownMemberDids: options.policy.knownMemberDids,
    seenUpdates: options.policy.seenUpdates,
    incomingUpdate: options.signal,
  })

  const localImpact = computeLocalImpact(disposition, options.signal, options.localDid)

  switch (disposition) {
    case 'store-pending-and-sync':
    case 'store-unverified-pending-and-sync':
      await options.store.savePending({ ...options.signal, storedDisposition: disposition })
      return { disposition, triggerSpaceCatchUp: true, ackable: true, localImpact }
    case 'upgrade-pending-and-sync':
      await options.store.upgradePending({ ...options.signal, storedDisposition: 'store-pending-and-sync' })
      return { disposition, triggerSpaceCatchUp: true, ackable: true, localImpact }
    case 'buffer-future-and-catch-up':
      await options.store.bufferFuture(options.signal)
      return { disposition, triggerSpaceCatchUp: true, ackable: true, localImpact: 'none' }
    case 'ignore-lower-authority':
    case 'ignore-duplicate':
    case 'ignore-stale':
      return { disposition, triggerSpaceCatchUp: false, ackable: true, localImpact: 'none' }
  }
}

function computeLocalImpact(
  disposition: MemberUpdateDisposition,
  signal: MemberUpdateSignal,
  localDid: string,
): LocalImpact {
  if (signal.memberDid !== localDid) return 'none'
  // Sync 005 Z.183-184: only an authorized (signed) pending carries local UX impact.
  // An unverified pending MUST NOT trigger trust-based UX.
  if (disposition !== 'store-pending-and-sync' && disposition !== 'upgrade-pending-and-sync') return 'none'
  return signal.action === 'removed' ? 'mark-removal-pending' : 'mark-addition-pending'
}
