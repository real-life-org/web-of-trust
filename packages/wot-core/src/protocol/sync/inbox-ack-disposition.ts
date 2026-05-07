export type InboxAckProcessingStatus = 'incomplete' | 'complete' | 'failed'
export type InboxAckReplayStatus = 'incomplete' | 'unique' | 'duplicate-known' | 'failed'
export type InboxAckScope = 'authenticated-device-only'
export type InboxAckMeaning = 'transport-persistence-only'
export type InboxAckSemanticEffect = 'none'

export type InboxMessageKind =
  | 'attestation'
  | 'verification'
  | 'space-invite'
  | 'member-update'
  | 'key-rotation'
  | 'inbox'
  | 'unknown'

export type InboxAckMissingDependency =
  | {
      kind: 'missing-key-generation'
      docId: string
      keyGeneration: number
    }
  | {
      kind: 'missing-space-invite'
      docId: string
    }
  | {
      kind: 'missing-log-entry'
      docId: string
      deviceId?: string
      seq?: number
    }
  | {
      kind: 'missing-personal-doc'
      docId?: string
    }
  | {
      kind: 'missing-other'
      detail: string
    }

export type InboxAckIncompleteWork =
  | 'decryption'
  | 'inner-verification'
  | 'replay-check'
  | 'durable-apply'
  | 'durable-buffer'
  | 'invalid-rejection-audit'

export type InboxInvalidRejectionReason =
  | 'decryption-failed'
  | 'inner-verification-failed'
  | 'replay-rejected'
  | 'wrong-recipient'
  | 'expired'
  | 'malformed'
  | 'unknown-required-type'

export type InboxAckLocalOutcome =
  | {
      kind: 'applied'
      durable: boolean
    }
  | {
      kind: 'pending'
      durability: 'durable' | 'volatile' | 'not-buffered'
      dependencies: readonly InboxAckMissingDependency[]
    }
  | {
      kind: 'processing-incomplete'
      waitingOn: InboxAckIncompleteWork
    }
  | {
      kind: 'invalid-rejected'
      rejection: InboxInvalidRejectionReason
      authoritativeStateChanged: boolean
    }
  | {
      kind: 'duplicate'
      source: 'replay-history'
    }

export interface InboxAckDispositionInput {
  messageKind?: InboxMessageKind
  decryption: InboxAckProcessingStatus
  innerVerification: InboxAckProcessingStatus
  replayCheck: InboxAckReplayStatus
  localOutcome: InboxAckLocalOutcome
}

export type InboxAckDisposition =
  | {
      action: 'send-ack'
      reason: 'applied' | 'durably-buffered-pending' | 'duplicate-replay-history'
      ackScope: InboxAckScope
      ackMeaning: InboxAckMeaning
      semanticEffect: InboxAckSemanticEffect
    }
  | {
      action: 'may-ack-invalid-and-drop'
      reason: 'invalid-rejected'
      authoritativeStateChanged: false
      ackScope: InboxAckScope
      ackMeaning: InboxAckMeaning
      semanticEffect: InboxAckSemanticEffect
    }
  | {
      action: 'do-not-ack'
      reason: 'processing-incomplete' | 'pending-not-durable' | 'apply-not-durable' | 'invalid-changed-state'
    }

const ACK_SCOPE: InboxAckScope = 'authenticated-device-only'
const ACK_MEANING: InboxAckMeaning = 'transport-persistence-only'
const SEMANTIC_EFFECT: InboxAckSemanticEffect = 'none'

export function evaluateInboxAckDisposition(input: InboxAckDispositionInput): InboxAckDisposition {
  if (input.localOutcome.kind === 'processing-incomplete') return doNotAck('processing-incomplete')

  if (processingIncomplete(input)) return doNotAck('processing-incomplete')

  switch (input.localOutcome.kind) {
    case 'applied':
      if (!input.localOutcome.durable) return doNotAck('apply-not-durable')
      return sendAck('applied')

    case 'pending':
      if (input.localOutcome.durability !== 'durable' || input.localOutcome.dependencies.length === 0) {
        return doNotAck('pending-not-durable')
      }
      return sendAck('durably-buffered-pending')

    case 'invalid-rejected':
      if (input.localOutcome.authoritativeStateChanged) return doNotAck('invalid-changed-state')
      return {
        action: 'may-ack-invalid-and-drop',
        reason: 'invalid-rejected',
        authoritativeStateChanged: false,
        ...ackBoundary(),
      }

    case 'duplicate':
      return sendAck('duplicate-replay-history')
  }
}

function processingIncomplete(input: InboxAckDispositionInput): boolean {
  if (input.decryption === 'incomplete') return true
  if (input.innerVerification === 'incomplete') return true
  if (input.replayCheck === 'incomplete') return true
  if (input.localOutcome.kind === 'invalid-rejected') return false
  if (input.decryption === 'failed') return true
  if (input.innerVerification === 'failed') return true
  if (input.replayCheck === 'failed') return true
  if (input.localOutcome.kind === 'duplicate') return input.replayCheck !== 'duplicate-known'
  return false
}

function sendAck(reason: 'applied' | 'durably-buffered-pending' | 'duplicate-replay-history'): InboxAckDisposition {
  return {
    action: 'send-ack',
    reason,
    ...ackBoundary(),
  }
}

function doNotAck(reason: Extract<InboxAckDisposition, { action: 'do-not-ack' }>['reason']): InboxAckDisposition {
  return {
    action: 'do-not-ack',
    reason,
  }
}

function ackBoundary(): {
  ackScope: InboxAckScope
  ackMeaning: InboxAckMeaning
  semanticEffect: InboxAckSemanticEffect
} {
  return {
    ackScope: ACK_SCOPE,
    ackMeaning: ACK_MEANING,
    semanticEffect: SEMANTIC_EFFECT,
  }
}
