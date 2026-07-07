import { describe, expect, it } from 'vitest'
import { evaluateInboxAckDisposition } from '../src/protocol'
import type { InboxAckDispositionInput } from '../src/protocol'

const DEVICE_ACK_SCOPE = 'authenticated-device-only'
const TRANSPORT_ONLY = 'transport-persistence-only'
const NO_SEMANTIC_EFFECT = 'none'

function baseInput(overrides: Partial<InboxAckDispositionInput> = {}): InboxAckDispositionInput {
  return {
    decryption: 'complete',
    innerVerification: 'complete',
    replayCheck: 'unique',
    localOutcome: {
      kind: 'applied',
      durable: true,
    },
    ...overrides,
  }
}

describe('inbox ACK disposition invariants', () => {
  it('allows ACK only as a per-device transport and persistence confirmation after durable apply', () => {
    expect(evaluateInboxAckDisposition(baseInput())).toEqual({
      action: 'send-ack',
      reason: 'applied',
      ackScope: DEVICE_ACK_SCOPE,
      ackMeaning: TRANSPORT_ONLY,
      semanticEffect: NO_SEMANTIC_EFFECT,
    })
  })

  it('does not ACK applied messages before durable local persistence', () => {
    expect(evaluateInboxAckDisposition(baseInput({
      localOutcome: {
        kind: 'applied',
        durable: false,
      },
    }))).toEqual({
      action: 'do-not-ack',
      reason: 'apply-not-durable',
    })
  })

  it('allows ACK after missing dependencies were durably buffered with dependency metadata', () => {
    expect(evaluateInboxAckDisposition(baseInput({
      localOutcome: {
        kind: 'pending',
        durability: 'durable',
        dependencies: [
          {
            kind: 'missing-key-generation',
            docId: '7f3a2b10-4c5d-4e6f-8a7b-9c0d1e2f3a4b',
            keyGeneration: 4,
          },
        ],
      },
    }))).toEqual({
      action: 'send-ack',
      reason: 'durably-buffered-pending',
      ackScope: DEVICE_ACK_SCOPE,
      ackMeaning: TRANSPORT_ONLY,
      semanticEffect: NO_SEMANTIC_EFFECT,
    })
  })

  it('does not ACK missing dependencies held only in volatile memory', () => {
    expect(evaluateInboxAckDisposition(baseInput({
      localOutcome: {
        kind: 'pending',
        durability: 'volatile',
        dependencies: [
          {
            kind: 'missing-space-invite',
            docId: '7f3a2b10-4c5d-4e6f-8a7b-9c0d1e2f3a4b',
          },
        ],
      },
    }))).toEqual({
      action: 'do-not-ack',
      reason: 'pending-not-durable',
    })
  })

  it('does not ACK before decryption, verification, replay check, or durable work has completed', () => {
    const incompleteCases: InboxAckDispositionInput[] = [
      baseInput({ decryption: 'incomplete' }),
      baseInput({ innerVerification: 'incomplete' }),
      baseInput({ replayCheck: 'incomplete' }),
      baseInput({
        localOutcome: {
          kind: 'processing-incomplete',
          waitingOn: 'durable-apply',
        },
      }),
      baseInput({
        localOutcome: {
          kind: 'processing-incomplete',
          waitingOn: 'durable-buffer',
        },
      }),
    ]

    for (const input of incompleteCases) {
      expect(evaluateInboxAckDisposition(input)).toEqual({
        action: 'do-not-ack',
        reason: 'processing-incomplete',
      })
    }
  })

  it('allows invalid messages to be ACKed and dropped only after conclusive rejection without state changes', () => {
    expect(evaluateInboxAckDisposition(baseInput({
      localOutcome: {
        kind: 'invalid-rejected',
        rejection: 'inner-verification-failed',
        authoritativeStateChanged: false,
      },
    }))).toEqual({
      action: 'may-ack-invalid-and-drop',
      reason: 'invalid-rejected',
      authoritativeStateChanged: false,
      ackScope: DEVICE_ACK_SCOPE,
      ackMeaning: TRANSPORT_ONLY,
      semanticEffect: NO_SEMANTIC_EFFECT,
    })
  })

  it('does not ACK invalid messages after authoritative state changes', () => {
    expect(evaluateInboxAckDisposition(baseInput({
      localOutcome: {
        kind: 'invalid-rejected',
        rejection: 'malformed',
        authoritativeStateChanged: true,
      },
    }))).toEqual({
      action: 'do-not-ack',
      reason: 'invalid-changed-state',
    })
  })

  it('does not ACK invalid messages while rejection is not yet conclusive', () => {
    expect(evaluateInboxAckDisposition(baseInput({
      decryption: 'failed',
      localOutcome: {
        kind: 'processing-incomplete',
        waitingOn: 'invalid-rejection-audit',
      },
    }))).toEqual({
      action: 'do-not-ack',
      reason: 'processing-incomplete',
    })
  })

  it('treats replay-history duplicates as ACK-eligible idempotent outcomes', () => {
    expect(evaluateInboxAckDisposition(baseInput({
      replayCheck: 'duplicate-known',
      localOutcome: {
        kind: 'duplicate',
        source: 'replay-history',
      },
    }))).toEqual({
      action: 'send-ack',
      reason: 'duplicate-replay-history',
      ackScope: DEVICE_ACK_SCOPE,
      ackMeaning: TRANSPORT_ONLY,
      semanticEffect: NO_SEMANTIC_EFFECT,
    })
  })

  it('does not model ACK as attestation acceptance, trust, reading, display, or publication', () => {
    const disposition = evaluateInboxAckDisposition(baseInput({
      messageKind: 'attestation',
      localOutcome: {
        kind: 'applied',
        durable: true,
      },
    }))

    expect(disposition).toMatchObject({
      action: 'send-ack',
      ackMeaning: TRANSPORT_ONLY,
      semanticEffect: NO_SEMANTIC_EFFECT,
    })
    expect(disposition).not.toHaveProperty('attestationAck')
    expect(disposition).not.toHaveProperty('accepted')
    expect(disposition).not.toHaveProperty('trusted')
    expect(disposition).not.toHaveProperty('read')
    expect(disposition).not.toHaveProperty('displayed')
    expect(disposition).not.toHaveProperty('published')
  })
})
