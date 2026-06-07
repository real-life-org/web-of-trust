import { describe, expect, it } from 'vitest'
import {
  createVerificationDeliveryWorkflow,
  findOriginalVerificationAttestation,
  type VerificationDeliveryPorts,
} from '../src/application/verification/verification-delivery-workflow'
import type { Attestation } from '../src/types/attestation'
import type { DeliveryReceipt, MessageEnvelope } from '../src/types/messaging'
import { createResourceRef } from '../src/types/resource-ref'
import { signEnvelope } from '../src/crypto/envelope-auth'
import { createTestIdentity } from './helpers/identity-session'

const FROM_DID = 'did:key:zFromAlice'
const TO_DID = 'did:key:zToBen'
const FIXED_NOW = new Date('2026-06-07T10:00:00.000Z')

function makeAttestation(overrides: Partial<Attestation> = {}): Attestation {
  return {
    id: 'urn:uuid:att-deliver-1',
    from: FROM_DID,
    to: TO_DID,
    claim: 'in-person verifiziert',
    createdAt: '2026-06-07T09:59:00.000Z',
    vcJws: 'header.payload.signature',
    ...overrides,
  }
}

interface CallLog {
  events: string[]
  sent: MessageEnvelope[]
  saved: Attestation[]
  added: Array<{ did: string; publicKey: string; name?: string; status: string }>
  synced: string[]
}

function makePorts(
  overrides: Partial<VerificationDeliveryPorts> = {},
): { ports: VerificationDeliveryPorts; log: CallLog } {
  const log: CallLog = { events: [], sent: [], saved: [], added: [], synced: [] }

  const ports: VerificationDeliveryPorts = {
    now: () => FIXED_NOW,
    send: async (envelope: MessageEnvelope): Promise<DeliveryReceipt> => {
      log.events.push('send')
      log.sent.push(envelope)
      return { messageId: envelope.id, status: 'accepted', timestamp: FIXED_NOW.toISOString() }
    },
    signEnvelope: async (envelope: MessageEnvelope): Promise<void> => {
      log.events.push('signEnvelope')
      envelope.signature = 'fake-signature'
    },
    saveAttestation: async (attestation: Attestation): Promise<void> => {
      log.events.push('saveAttestation')
      log.saved.push(attestation)
    },
    addContact: async (did, publicKey, name, status): Promise<void> => {
      log.events.push('addContact')
      log.added.push({ did, publicKey, name, status })
    },
    syncContactProfile: (did: string): void => {
      log.events.push('syncContactProfile')
      log.synced.push(did)
    },
    ...overrides,
  }

  return { ports, log }
}

describe('createVerificationDeliveryWorkflow', () => {
  it('produces the relay attestation envelope with deterministic bytes', async () => {
    const { ports } = makePorts()
    const workflow = createVerificationDeliveryWorkflow(ports)
    const attestation = makeAttestation()

    const result = await workflow.deliverAttestation({
      attestation,
      fromDid: FROM_DID,
      toDid: TO_DID,
    })

    expect(result.envelope).toEqual({
      v: 1,
      id: attestation.id,
      type: 'attestation',
      fromDid: FROM_DID,
      toDid: TO_DID,
      createdAt: FIXED_NOW.toISOString(),
      encoding: 'json',
      payload: JSON.stringify(attestation),
      signature: 'fake-signature',
      ref: 'wot:attestation:urn:uuid:att-deliver-1',
    })
    expect(result.receipt).toEqual({
      messageId: attestation.id,
      status: 'accepted',
      timestamp: FIXED_NOW.toISOString(),
    })
  })

  it('honours an explicit createdAt (CLI uses attestation.createdAt)', async () => {
    const { ports } = makePorts()
    const workflow = createVerificationDeliveryWorkflow(ports)
    const attestation = makeAttestation()

    const result = await workflow.deliverAttestation({
      attestation,
      fromDid: FROM_DID,
      toDid: TO_DID,
      createdAt: attestation.createdAt,
    })

    expect(result.envelope.createdAt).toBe(attestation.createdAt)
  })

  it('runs side effects in order: addContact -> syncContactProfile -> saveAttestation -> signEnvelope -> send', async () => {
    const { ports, log } = makePorts()
    const workflow = createVerificationDeliveryWorkflow(ports)
    const attestation = makeAttestation()

    await workflow.deliverAttestation({
      attestation,
      fromDid: FROM_DID,
      toDid: TO_DID,
      contact: { did: TO_DID, publicKey: 'pk-ben', name: 'Ben', status: 'active' },
    })

    expect(log.events).toEqual([
      'addContact',
      'syncContactProfile',
      'saveAttestation',
      'signEnvelope',
      'send',
    ])
    expect(log.added).toEqual([{ did: TO_DID, publicKey: 'pk-ben', name: 'Ben', status: 'active' }])
    expect(log.synced).toEqual([TO_DID])
  })

  it('calls syncContactProfile fire-and-forget (never awaited)', async () => {
    let resolveSync: (() => void) | null = null
    const { ports } = makePorts({
      // A promise that never resolves on its own — if deliverAttestation awaited
      // this, the call below would hang and the test would time out.
      syncContactProfile: () =>
        new Promise<void>((resolve) => {
          resolveSync = resolve
        }),
    })
    const workflow = createVerificationDeliveryWorkflow(ports)

    const result = await workflow.deliverAttestation({
      attestation: makeAttestation(),
      fromDid: FROM_DID,
      toDid: TO_DID,
      contact: { did: TO_DID, publicKey: 'pk-ben', name: 'Ben', status: 'active' },
    })

    expect(result.envelope.signature).toBe('fake-signature')
    expect(typeof resolveSync).toBe('function')
    resolveSync?.()
  })

  it('swallows send failures -> receipt null, no throw', async () => {
    const { ports, log } = makePorts({
      send: async () => {
        log.events.push('send')
        throw new Error('relay offline')
      },
    })
    const workflow = createVerificationDeliveryWorkflow(ports)

    const result = await workflow.deliverAttestation({
      attestation: makeAttestation(),
      fromDid: FROM_DID,
      toDid: TO_DID,
    })

    expect(result.receipt).toBeNull()
    expect(result.envelope.signature).toBe('fake-signature')
  })

  it('persist=false skips saveAttestation', async () => {
    const { ports, log } = makePorts()
    const workflow = createVerificationDeliveryWorkflow(ports)

    await workflow.deliverAttestation({
      attestation: makeAttestation(),
      fromDid: FROM_DID,
      toDid: TO_DID,
      persist: false,
    })

    expect(log.saved).toEqual([])
    expect(log.events).toEqual(['signEnvelope', 'send'])
  })

  it('without contact, neither addContact nor syncContactProfile is called', async () => {
    const { ports, log } = makePorts()
    const workflow = createVerificationDeliveryWorkflow(ports)

    await workflow.deliverAttestation({
      attestation: makeAttestation(),
      fromDid: FROM_DID,
      toDid: TO_DID,
    })

    expect(log.added).toEqual([])
    expect(log.synced).toEqual([])
    expect(log.events).toEqual(['saveAttestation', 'signEnvelope', 'send'])
  })

  it('defaults createdAt to now() when not provided', async () => {
    const { ports } = makePorts({ now: () => new Date('2030-01-01T00:00:00.000Z') })
    const workflow = createVerificationDeliveryWorkflow(ports)

    const result = await workflow.deliverAttestation({
      attestation: makeAttestation(),
      fromDid: FROM_DID,
      toDid: TO_DID,
    })

    expect(result.envelope.createdAt).toBe('2030-01-01T00:00:00.000Z')
  })
})

describe('verification-delivery-workflow behavior parity (byte-for-byte)', () => {
  // Locks the extraction: the workflow must produce exactly the same signed
  // envelope as the demo hook / CLI built inline, using the real (deprecated)
  // signEnvelope helper bound as a port.
  it('matches the inline-built + signed envelope byte-for-byte', async () => {
    const { identity } = await createTestIdentity('alice')
    const fromDid = identity.getDid()
    const toDid = 'did:key:zRecipient'
    const attestation = makeAttestation({ from: fromDid, to: toDid })
    const createdAt = attestation.createdAt

    // Reference: exactly the inline literal the hook/CLI build, then sign.
    const reference: MessageEnvelope = {
      v: 1,
      id: attestation.id,
      type: 'attestation',
      fromDid,
      toDid,
      createdAt,
      encoding: 'json',
      payload: JSON.stringify(attestation),
      signature: '',
      ref: createResourceRef('attestation', attestation.id),
    }
    await signEnvelope(reference, (data) => identity.sign(data))

    const workflow = createVerificationDeliveryWorkflow({
      send: async (envelope) => ({
        messageId: envelope.id,
        status: 'accepted',
        timestamp: createdAt,
      }),
      signEnvelope: (envelope) => signEnvelope(envelope, (data) => identity.sign(data)).then(() => undefined),
      saveAttestation: async () => {},
      addContact: async () => {},
      syncContactProfile: () => {},
    })

    const { envelope } = await workflow.deliverAttestation({
      attestation,
      fromDid,
      toDid,
      createdAt,
      persist: false,
    })

    expect(envelope).toEqual(reference)
  })
})

describe('findOriginalVerificationAttestation', () => {
  const TARGET = 'did:key:zTarget'
  const LOCAL = 'did:key:zLocal'
  const CLAIM = 'in-person verifiziert'

  it('picks the newest incoming nonce-bound verification-attestation', () => {
    const older = makeAttestation({
      id: 'urn:uuid:older',
      from: TARGET,
      to: LOCAL,
      claim: CLAIM,
      createdAt: '2026-06-01T08:00:00.000Z',
    })
    const newer = makeAttestation({
      id: 'urn:uuid:newer',
      from: TARGET,
      to: LOCAL,
      claim: CLAIM,
      createdAt: '2026-06-05T08:00:00.000Z',
    })
    const counter = makeAttestation({
      id: 'urn:uuid:counter',
      from: TARGET,
      to: LOCAL,
      claim: CLAIM,
      inResponseTo: 'urn:uuid:something',
      createdAt: '2026-06-06T08:00:00.000Z',
    })

    const found = findOriginalVerificationAttestation([older, newer, counter], {
      targetDid: TARGET,
      localDid: LOCAL,
      claim: CLAIM,
    })

    expect(found?.id).toBe('urn:uuid:newer')
  })

  it('returns null when no matching original exists', () => {
    const counter = makeAttestation({
      from: TARGET,
      to: LOCAL,
      claim: CLAIM,
      inResponseTo: 'urn:uuid:x',
    })

    const found = findOriginalVerificationAttestation([counter], {
      targetDid: TARGET,
      localDid: LOCAL,
      claim: CLAIM,
    })

    expect(found).toBeNull()
  })
})
