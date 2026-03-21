import { describe, it, expect } from 'vitest'
import { signEnvelope, verifyEnvelope, canonicalSigningInput } from '../src/crypto/envelope-auth'
import type { MessageEnvelope } from '../src/types/messaging'
import { WotIdentity } from '../src/identity/WotIdentity'

function makeEnvelope(overrides?: Partial<MessageEnvelope>): MessageEnvelope {
  return {
    v: 1,
    id: 'test-id-123',
    type: 'member-update',
    fromDid: 'did:key:z6MkpTHR8VNsBxYAAWHut2Geadd9jSwuBV8xRoAnwWsdvktH',
    toDid: 'did:key:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK',
    createdAt: '2026-03-11T12:00:00.000Z',
    encoding: 'json',
    payload: JSON.stringify({ spaceId: 'abc', action: 'added', members: ['a', 'b'] }),
    signature: '',
    ...overrides,
  }
}

async function createIdentity(): Promise<WotIdentity> {
  const identity = new WotIdentity()
  await identity.create('test-pass', false)
  return identity
}

describe('Envelope Authentication', () => {
  describe('canonicalSigningInput', () => {
    it('should produce deterministic pipe-separated string', () => {
      const envelope = makeEnvelope()
      const input = canonicalSigningInput(envelope)
      expect(input).toContain('|')
      expect(input.split('|').length).toBe(7)
      expect(input.startsWith('1|test-id-123|member-update|')).toBe(true)
    })

    it('should include all critical fields', () => {
      const envelope = makeEnvelope()
      const input = canonicalSigningInput(envelope)
      expect(input).toContain(envelope.id)
      expect(input).toContain(envelope.type)
      expect(input).toContain(envelope.fromDid)
      expect(input).toContain(envelope.toDid)
      expect(input).toContain(envelope.createdAt)
      expect(input).toContain(envelope.payload)
    })
  })

  describe('signEnvelope + verifyEnvelope', () => {
    it('should sign and verify successfully with matching identity', async () => {
      const identity = await createIdentity()
      const did = identity.getDid()

      const envelope = makeEnvelope({ fromDid: did })
      expect(envelope.signature).toBe('')

      await signEnvelope(envelope, (data) => identity.sign(data))
      expect(envelope.signature).not.toBe('')
      expect(envelope.signature.length).toBeGreaterThan(10)

      const valid = await verifyEnvelope(envelope)
      expect(valid).toBe(true)
    })

    it('should reject envelope with tampered payload', async () => {
      const identity = await createIdentity()
      const did = identity.getDid()

      const envelope = makeEnvelope({ fromDid: did })
      await signEnvelope(envelope, (data) => identity.sign(data))

      // Tamper with payload
      envelope.payload = JSON.stringify({ spaceId: 'HACKED', action: 'removed', members: [] })

      const valid = await verifyEnvelope(envelope)
      expect(valid).toBe(false)
    })

    it('should reject envelope with tampered fromDid', async () => {
      const identity = await createIdentity()
      const attacker = await createIdentity()

      const envelope = makeEnvelope({ fromDid: identity.getDid() })
      await signEnvelope(envelope, (data) => identity.sign(data))

      // Attacker changes fromDid to their own (but signature was made with original identity)
      envelope.fromDid = attacker.getDid()

      const valid = await verifyEnvelope(envelope)
      expect(valid).toBe(false)
    })

    it('should reject envelope signed by wrong identity', async () => {
      const identity = await createIdentity()
      const attacker = await createIdentity()

      // Envelope claims to be from identity, but signed by attacker
      const envelope = makeEnvelope({ fromDid: identity.getDid() })
      await signEnvelope(envelope, (data) => attacker.sign(data))

      const valid = await verifyEnvelope(envelope)
      expect(valid).toBe(false)
    })

    it('should reject envelope with empty signature', async () => {
      const envelope = makeEnvelope()
      envelope.signature = ''

      const valid = await verifyEnvelope(envelope)
      expect(valid).toBe(false)
    })

    it('should reject envelope with invalid signature string', async () => {
      const envelope = makeEnvelope()
      envelope.signature = 'not-a-valid-base64url-signature'

      const valid = await verifyEnvelope(envelope)
      expect(valid).toBe(false)
    })

    it('should handle different message types', async () => {
      const identity = await createIdentity()
      const did = identity.getDid()

      for (const type of ['space-invite', 'group-key-rotation', 'member-update', 'content'] as const) {
        const envelope = makeEnvelope({ fromDid: did, type })
        await signEnvelope(envelope, (data) => identity.sign(data))

        const valid = await verifyEnvelope(envelope)
        expect(valid).toBe(true)
      }
    })
  })
})
