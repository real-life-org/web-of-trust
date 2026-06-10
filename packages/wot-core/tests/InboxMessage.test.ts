import { describe, expect, it } from 'vitest'
import {
  ENCRYPTED_INBOX_MESSAGE_TYPES,
  INBOX_MESSAGE_TYPE,
  KEY_ROTATION_MESSAGE_TYPE,
  MEMBER_UPDATE_MESSAGE_TYPE,
  SPACE_INVITE_MESSAGE_TYPE,
  assertAttestationDeliveryBody,
  assertEncryptedInboxEnvelope,
  extractInboxExtensionFields,
  isDidcommMessage,
  isEncryptedInboxMessageType,
} from '../src/protocol'

// K4: encrypted-Outer-Familie — auf dem Wire ist der Body der ECIES-Container
// {epk, nonce, ciphertext} (Sync 001 §Verschlüsseltes Nachrichtenformat);
// die logische Klartext-Form (assert*Message) existiert auf dem Wire nie.

const FROM = 'did:key:z6Mki7w5nqgiJ1KecCGzGuxr4hh7aQUjVc2PYSZazGsB6M4r'
const TO = 'did:key:z6Mkv1Y7GdtkqFJrVtX8BrXzPkS7mZYmrQu7izBtLqD2aLEj'

function encryptedEnvelope(overrides: Record<string, unknown> = {}) {
  return {
    id: '550e8400-e29b-41d4-a716-446655440000',
    typ: 'application/didcomm-plain+json',
    type: INBOX_MESSAGE_TYPE,
    from: FROM,
    to: [TO],
    created_time: 1776945600,
    body: { epk: 'ZXBr', nonce: 'bm9uY2U', ciphertext: 'Y2lwaGVydGV4dA' },
    ...overrides,
  }
}

describe('assertEncryptedInboxEnvelope', () => {
  it('accepts a valid encrypted envelope for each of the four inbox type URIs', () => {
    for (const type of ENCRYPTED_INBOX_MESSAGE_TYPES) {
      expect(() => assertEncryptedInboxEnvelope(encryptedEnvelope({ type }), type)).not.toThrow()
    }
  })

  it('rejects a type mismatch against expectedType', () => {
    expect(() =>
      assertEncryptedInboxEnvelope(encryptedEnvelope(), SPACE_INVITE_MESSAGE_TYPE),
    ).toThrow('Invalid inbox envelope type')
  })

  it('rejects a missing or empty to (Sync 003 Z.378: Pflicht bei Inbox-Nachrichten)', () => {
    expect(() =>
      assertEncryptedInboxEnvelope(encryptedEnvelope({ to: undefined }), INBOX_MESSAGE_TYPE),
    ).toThrow()
    expect(() => assertEncryptedInboxEnvelope(encryptedEnvelope({ to: [] }), INBOX_MESSAGE_TYPE)).toThrow()
  })

  it('rejects a body missing an ECIES field or with non-base64url content', () => {
    const { epk: _epk, ...withoutEpk } = encryptedEnvelope().body as Record<string, unknown>
    expect(() =>
      assertEncryptedInboxEnvelope(encryptedEnvelope({ body: withoutEpk }), INBOX_MESSAGE_TYPE),
    ).toThrow('Invalid inbox encrypted body epk')
    expect(() =>
      assertEncryptedInboxEnvelope(
        encryptedEnvelope({ body: { epk: 'ZXBr', nonce: 'not base64url!', ciphertext: 'Y2lwaGVydGV4dA' } }),
        INBOX_MESSAGE_TYPE,
      ),
    ).toThrow('Invalid inbox encrypted body nonce')
  })

  it('rejects number[]-arrays in place of Base64URL strings (#189-P1-Container-Form)', () => {
    expect(() =>
      assertEncryptedInboxEnvelope(
        encryptedEnvelope({ body: { epk: [1, 2, 3], nonce: [4, 5, 6], ciphertext: [7, 8, 9] } }),
        INBOX_MESSAGE_TYPE,
      ),
    ).toThrow('Invalid inbox encrypted body epk')
  })

  it('rejects an old-world MessageEnvelope', () => {
    const oldWorld = {
      v: 1,
      id: '550e8400-e29b-41d4-a716-446655440000',
      type: 'attestation',
      fromDid: FROM,
      toDid: TO,
      createdAt: '2026-06-10T12:00:00Z',
      encoding: 'json',
      payload: '{}',
      signature: 'sig',
    }
    expect(() => assertEncryptedInboxEnvelope(oldWorld, INBOX_MESSAGE_TYPE)).toThrow()
  })

  it('accepts extension fields next to the ECIES container and extracts them (VE-5)', () => {
    const envelope = encryptedEnvelope({
      body: { epk: 'ZXBr', nonce: 'bm9uY2U', ciphertext: 'Y2lwaGVydGV4dA', encryptedDocSnapshot: 'AAECAw' },
    })
    assertEncryptedInboxEnvelope(envelope, INBOX_MESSAGE_TYPE)
    expect(extractInboxExtensionFields(envelope.body)).toEqual({ encryptedDocSnapshot: 'AAECAw' })
    expect(extractInboxExtensionFields(encryptedEnvelope().body)).toEqual({})
  })
})

describe('assertAttestationDeliveryBody (K2)', () => {
  it('accepts the minimal { vcJws } body', () => {
    expect(() => assertAttestationDeliveryBody({ vcJws: 'a.b.c' })).not.toThrow()
  })

  it('rejects extra properties — keine lokalen Attestation-Felder im Wire-Body', () => {
    expect(() => assertAttestationDeliveryBody({ vcJws: 'a.b.c', id: 'x' })).toThrow(
      'Invalid attestation delivery body property: id',
    )
  })

  it('rejects a non-compact-JWS vcJws', () => {
    expect(() => assertAttestationDeliveryBody({ vcJws: 'not-a-jws' })).toThrow()
    expect(() => assertAttestationDeliveryBody({ vcJws: 42 })).toThrow()
    expect(() => assertAttestationDeliveryBody({})).toThrow()
  })
})

describe('isDidcommMessage / isEncryptedInboxMessageType (VE-8 Familien-Split)', () => {
  it('discriminates the DIDComm family from old-world envelopes over typ', () => {
    expect(isDidcommMessage(encryptedEnvelope())).toBe(true)
    expect(isDidcommMessage({ v: 1, type: 'content', payload: '{}' })).toBe(false)
    expect(isDidcommMessage(null)).toBe(false)
    expect(isDidcommMessage('string')).toBe(false)
  })

  it('classifies exactly the four encrypted inbox type URIs', () => {
    expect(isEncryptedInboxMessageType(INBOX_MESSAGE_TYPE)).toBe(true)
    expect(isEncryptedInboxMessageType(SPACE_INVITE_MESSAGE_TYPE)).toBe(true)
    expect(isEncryptedInboxMessageType(MEMBER_UPDATE_MESSAGE_TYPE)).toBe(true)
    expect(isEncryptedInboxMessageType(KEY_ROTATION_MESSAGE_TYPE)).toBe(true)
    expect(isEncryptedInboxMessageType('https://web-of-trust.de/protocols/log-entry/1.0')).toBe(false)
    expect(isEncryptedInboxMessageType('https://web-of-trust.de/protocols/ack/1.0')).toBe(false)
    expect(isEncryptedInboxMessageType('attestation')).toBe(false)
  })
})
