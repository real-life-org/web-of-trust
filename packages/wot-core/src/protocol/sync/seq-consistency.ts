export type LocalBrokerSeqConsistencyDisposition =
  | 'restore-clone-required'
  | 'no-restore-clone-detected'

export type LocalBrokerSeqConsistencyReason =
  | 'broker-seq-greater-than-local-seq'
  | 'broker-seq-not-greater-than-local-seq'

export interface LocalBrokerSeqConsistencyInput {
  docId: string
  deviceId: string
  localSeq: number
  brokerSeq: number
}

export interface LocalBrokerSeqConsistencyResult {
  disposition: LocalBrokerSeqConsistencyDisposition
  reason: LocalBrokerSeqConsistencyReason
}

export type BrokerSeqCollisionDisposition =
  | 'accept-new-entry'
  | 'idempotent-retransmission'
  | 'reject-seq-collision'

export interface BrokerSeqCollisionInput {
  docId: string
  deviceId: string
  seq: number
  existingContentHash: string | null | undefined
  incomingContentHash: string
}

export type BrokerSeqCollisionResult =
  | { disposition: 'accept-new-entry' }
  | { disposition: 'idempotent-retransmission' }
  | {
    disposition: 'reject-seq-collision'
    errorCode: 'SEQ_COLLISION_DETECTED'
    clientHint: 'restore-clone-required'
  }

/** Implements Sync 002 seq-Konsistenz for broker/local seq comparison. */
export function classifyLocalBrokerSeqConsistency(
  input: LocalBrokerSeqConsistencyInput,
): LocalBrokerSeqConsistencyResult {
  assertSafeSeq(input.localSeq, 'localSeq')
  assertSafeSeq(input.brokerSeq, 'brokerSeq')

  if (input.brokerSeq > input.localSeq) {
    return {
      disposition: 'restore-clone-required',
      reason: 'broker-seq-greater-than-local-seq',
    }
  }

  return {
    disposition: 'no-restore-clone-detected',
    reason: 'broker-seq-not-greater-than-local-seq',
  }
}

export function classifyBrokerSeqCollision(input: BrokerSeqCollisionInput): BrokerSeqCollisionResult {
  assertSafeSeq(input.seq, 'seq')
  assertContentHash(input.incomingContentHash, 'incomingContentHash')
  if (input.existingContentHash == null) return { disposition: 'accept-new-entry' }
  assertContentHash(input.existingContentHash, 'existingContentHash')

  if (input.existingContentHash === input.incomingContentHash) {
    return { disposition: 'idempotent-retransmission' }
  }

  return {
    disposition: 'reject-seq-collision',
    errorCode: 'SEQ_COLLISION_DETECTED',
    clientHint: 'restore-clone-required',
  }
}

function assertSafeSeq(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`Invalid ${name}`)
}

function assertContentHash(value: string, name: string): void {
  if (typeof value !== 'string' || value.length === 0) throw new Error(`Invalid ${name}`)
}
