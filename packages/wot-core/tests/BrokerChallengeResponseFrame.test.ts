import { readFileSync } from 'node:fs'
import { beforeEach, describe, expect, it } from 'vitest'
import {
  assertBrokerChallengeResponseControlFrame,
  createBrokerChallengeResponseControlFrame,
  encodeBase64Url,
  parseBrokerChallengeResponseControlFrame,
} from '../src/protocol'

const phase1 = loadSpecVector('./fixtures/wot-spec/phase-1-interop.json')
const brokerVectors = phase1.broker_registration_control_frames
const DID = 'did:key:z6Mkalice'
const DEVICE_ID = '550e8400-e29b-41d4-a716-446655440000'
const CANONICAL_NONCE = 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8'
const SIGNATURE_BYTES = Uint8Array.from({ length: 64 }, (_, index) => index)
const CANONICAL_SIGNATURE = encodeBase64Url(SIGNATURE_BYTES)

function hexToBytes(hex: string): Uint8Array {
  if (hex.length % 2 !== 0) throw new Error('Invalid hex string')
  const bytes = new Uint8Array(hex.length / 2)
  for (let i = 0; i < bytes.length; i++) bytes[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16)
  return bytes
}

function loadSpecVector(relativePath: string): any {
  return JSON.parse(readFileSync(new URL(relativePath, import.meta.url), 'utf8'))
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')
}

function bytesToText(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes)
}

function validChallengeResponseFrame(overrides: Record<string, unknown> = {}) {
  return {
    type: 'challenge-response',
    did: DID,
    deviceId: DEVICE_ID,
    nonce: CANONICAL_NONCE,
    signature: CANONICAL_SIGNATURE,
    ...overrides,
  }
}

describe('Sync 003 broker challenge-response control frames', () => {
  beforeEach(() => {
    expect(typeof createBrokerChallengeResponseControlFrame).toBe('function')
    expect(typeof parseBrokerChallengeResponseControlFrame).toBe('function')
    expect(typeof assertBrokerChallengeResponseControlFrame).toBe('function')
  })

  it('constructs and parses a deterministic challenge-response control-frame', () => {
    const frame = createBrokerChallengeResponseControlFrame({
      did: DID,
      deviceId: DEVICE_ID,
      nonce: CANONICAL_NONCE,
      signature: SIGNATURE_BYTES,
    })

    expect(frame).toEqual(validChallengeResponseFrame())
    expect(parseBrokerChallengeResponseControlFrame(frame)).toEqual({
      type: 'challenge-response',
      did: DID,
      deviceId: DEVICE_ID,
      nonce: CANONICAL_NONCE,
      signature: CANONICAL_SIGNATURE,
      signatureBytes: SIGNATURE_BYTES,
      transcript: {
        protocol: 'wot/broker-auth/v1',
        type: 'challenge-response',
        did: DID,
        deviceId: DEVICE_ID,
        nonce: CANONICAL_NONCE,
      },
      signingBytes: new TextEncoder().encode(
        '{"deviceId":"550e8400-e29b-41d4-a716-446655440000","did":"did:key:z6Mkalice","nonce":"AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8","protocol":"wot/broker-auth/v1","type":"challenge-response"}',
      ),
    })
    expect(() => assertBrokerChallengeResponseControlFrame(frame)).not.toThrow()
  })

  it('roundtrips the normative 64-byte Ed25519 signature as exactly 86 unpadded Base64URL characters', () => {
    const parsed = parseBrokerChallengeResponseControlFrame(validChallengeResponseFrame())

    expect(CANONICAL_SIGNATURE).toHaveLength(86)
    expect(parsed.signature).toBe(CANONICAL_SIGNATURE)
    expect(parsed.signatureBytes).toEqual(SIGNATURE_BYTES)
  })

  it('reuses broker auth transcript canonicalization for nonce and signing-byte binding', () => {
    const parsed = parseBrokerChallengeResponseControlFrame(validChallengeResponseFrame())

    expect(parsed.transcript).toEqual({
      protocol: 'wot/broker-auth/v1',
      type: 'challenge-response',
      did: DID,
      deviceId: DEVICE_ID,
      nonce: CANONICAL_NONCE,
    })
    expect(new TextDecoder().decode(parsed.signingBytes)).toBe(
      '{"deviceId":"550e8400-e29b-41d4-a716-446655440000","did":"did:key:z6Mkalice","nonce":"AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8","protocol":"wot/broker-auth/v1","type":"challenge-response"}',
    )
  })

  it('matches the phase-1 interop vector for challenge-response frame, transcript, signing bytes, and signature encoding', () => {
    const signatureBytes = hexToBytes(brokerVectors.signature.ed25519_signature_hex)

    expect(createBrokerChallengeResponseControlFrame({
      did: brokerVectors.frames.challenge_response.did,
      deviceId: brokerVectors.frames.challenge_response.deviceId,
      nonce: brokerVectors.frames.challenge_response.nonce,
      signature: signatureBytes,
    })).toEqual(brokerVectors.frames.challenge_response)

    const parsed = parseBrokerChallengeResponseControlFrame(
      brokerVectors.frames.challenge_response,
    )

    expect(parsed.type).toBe(brokerVectors.frames.challenge_response.type)
    expect(parsed.did).toBe(brokerVectors.frames.challenge_response.did)
    expect(parsed.deviceId).toBe(brokerVectors.frames.challenge_response.deviceId)
    expect(parsed.nonce).toBe(brokerVectors.nonce.b64url)
    expect(parsed.signature).toBe(brokerVectors.signature.b64url)
    expect(parsed.signature).toHaveLength(brokerVectors.signature.length_chars)
    expect(bytesToHex(parsed.signatureBytes)).toBe(brokerVectors.signature.ed25519_signature_hex)
    expect(parsed.transcript).toEqual(brokerVectors.transcript.object)
    expect(bytesToText(parsed.signingBytes)).toBe(brokerVectors.transcript.jcs_canonical_string)
    expect(bytesToHex(parsed.signingBytes)).toBe(brokerVectors.transcript.jcs_canonical_hex)
  })

  it('rejects malformed signature encodings as MALFORMED_MESSAGE-level wire errors', () => {
    const invalidSignatures = [
      ['missing signature', undefined],
      ['empty signature', ''],
      ['padded Base64URL signature', `${CANONICAL_SIGNATURE}=`],
      ['standard Base64 plus', `${CANONICAL_SIGNATURE.slice(0, -1)}+`],
      ['standard Base64 slash', `${CANONICAL_SIGNATURE.slice(0, -1)}/`],
      ['hex signature', Array.from(SIGNATURE_BYTES, (byte) => byte.toString(16).padStart(2, '0')).join('')],
      ['multibase signature', `z${CANONICAL_SIGNATURE}`],
      ['wrong short length', CANONICAL_SIGNATURE.slice(0, -1)],
      ['wrong long length', `${CANONICAL_SIGNATURE}A`],
      ['non-string signature', SIGNATURE_BYTES],
      ['whitespace signature', `${CANONICAL_SIGNATURE.slice(0, -1)} `],
      ['non-canonical signature', `${CANONICAL_SIGNATURE.slice(0, -1)}9`],
    ] as const

    for (const [name, signature] of invalidSignatures) {
      const frame = signature === undefined
        ? {
            type: 'challenge-response',
            did: DID,
            deviceId: DEVICE_ID,
            nonce: CANONICAL_NONCE,
          }
        : validChallengeResponseFrame({ signature })

      expect(() => parseBrokerChallengeResponseControlFrame(frame), name).toThrow()
    }
  })

  it('rejects malformed or missing required challenge-response fields before crypto verification', () => {
    const invalidFrames = [
      ['non-object frame', null],
      ['missing type', {
        did: DID,
        deviceId: DEVICE_ID,
        nonce: CANONICAL_NONCE,
        signature: CANONICAL_SIGNATURE,
      }],
      ['wrong type', validChallengeResponseFrame({ type: 'challenge_response' })],
      ['missing did', validChallengeResponseFrame({ did: undefined })],
      ['empty did', validChallengeResponseFrame({ did: '' })],
      ['numeric did', validChallengeResponseFrame({ did: 123 })],
      ['missing deviceId', validChallengeResponseFrame({ deviceId: undefined })],
      ['uppercase deviceId', validChallengeResponseFrame({
        deviceId: '550E8400-E29B-41D4-A716-446655440000',
      })],
      ['non-v4 deviceId', validChallengeResponseFrame({
        deviceId: '550e8400-e29b-11d4-a716-446655440000',
      })],
      ['invalid deviceId', validChallengeResponseFrame({ deviceId: 'not-a-uuid' })],
      ['missing nonce', validChallengeResponseFrame({ nonce: undefined })],
      ['padded nonce', validChallengeResponseFrame({ nonce: `${CANONICAL_NONCE}=` })],
      ['standard Base64 nonce', validChallengeResponseFrame({ nonce: 'not/base64url' })],
      ['wrong-length nonce', validChallengeResponseFrame({
        nonce: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
      })],
    ] as const

    for (const [name, frame] of invalidFrames) {
      expect(() => parseBrokerChallengeResponseControlFrame(frame), name).toThrow()
    }
  })

  it('rejects inherited required fields on challenge-response control-frames', () => {
    const inheritedType = Object.create({ type: 'challenge-response' })
    inheritedType.did = DID
    inheritedType.deviceId = DEVICE_ID
    inheritedType.nonce = CANONICAL_NONCE
    inheritedType.signature = CANONICAL_SIGNATURE

    const inheritedDid = Object.create({ did: DID })
    inheritedDid.type = 'challenge-response'
    inheritedDid.deviceId = DEVICE_ID
    inheritedDid.nonce = CANONICAL_NONCE
    inheritedDid.signature = CANONICAL_SIGNATURE

    const inheritedSignature = Object.create({ signature: CANONICAL_SIGNATURE })
    inheritedSignature.type = 'challenge-response'
    inheritedSignature.did = DID
    inheritedSignature.deviceId = DEVICE_ID
    inheritedSignature.nonce = CANONICAL_NONCE

    expect(() => parseBrokerChallengeResponseControlFrame(inheritedType)).toThrow()
    expect(() => parseBrokerChallengeResponseControlFrame(inheritedDid)).toThrow()
    expect(() => parseBrokerChallengeResponseControlFrame(inheritedSignature)).toThrow()
  })

  it('rejects unknown top-level fields for the closed challenge-response control-frame shape', () => {
    expect(() => parseBrokerChallengeResponseControlFrame(validChallengeResponseFrame({
      brokerTraceId: 'trace-123',
    }))).toThrow()
  })

  it('rejects WoT Transport Envelope fields because challenge-response is a Broker Control-Frame', () => {
    for (const forbiddenField of ['id', 'typ', 'from', 'to', 'created_time']) {
      expect(() =>
        parseBrokerChallengeResponseControlFrame(validChallengeResponseFrame({
          [forbiddenField]: forbiddenField === 'to' ? ['did:key:z6Mkbob'] : 'forbidden',
        })),
      forbiddenField).toThrow()
    }
  })
})
