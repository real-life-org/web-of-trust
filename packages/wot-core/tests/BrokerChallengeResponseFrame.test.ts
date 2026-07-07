import { readFileSync } from 'node:fs'
import { beforeEach, describe, expect, it } from 'vitest'
import {
  assertBrokerChallengeResponseControlFrame,
  createBrokerChallengeResponseControlFrame,
  encodeBase64Url,
  parseBrokerChallengeResponseControlFrame,
  verifyBrokerChallengeResponseControlFrame,
} from '../src/protocol'
import { WebCryptoProtocolCryptoAdapter } from '../src/adapters/protocol-crypto'
import type { ProtocolCryptoAdapter } from '../src/protocol'

const phase1 = loadSpecVector('./fixtures/wot-spec/phase-1-interop.json')
const brokerVectors = phase1.broker_registration_control_frames
const DID = 'did:key:z6Mkalice'
const DEVICE_ID = '550e8400-e29b-41d4-a716-446655440000'
const CANONICAL_NONCE = 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8'
const SIGNATURE_BYTES = Uint8Array.from({ length: 64 }, (_, index) => index)
const CANONICAL_SIGNATURE = encodeBase64Url(SIGNATURE_BYTES)
const cryptoAdapter = new WebCryptoProtocolCryptoAdapter()

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

function vectorPendingChallenge(overrides: Record<string, unknown> = {}) {
  return {
    did: brokerVectors.frames.register.did,
    deviceId: brokerVectors.frames.register.deviceId,
    nonce: brokerVectors.frames.challenge.nonce,
    ...overrides,
  }
}

function cryptoWithVerify(
  verifyEd25519: ProtocolCryptoAdapter['verifyEd25519'],
): ProtocolCryptoAdapter {
  return {
    verifyEd25519,
    sha256: cryptoAdapter.sha256.bind(cryptoAdapter),
    hkdfSha256: cryptoAdapter.hkdfSha256.bind(cryptoAdapter),
    x25519PublicFromSeed: cryptoAdapter.x25519PublicFromSeed.bind(cryptoAdapter),
    x25519SharedSecret: cryptoAdapter.x25519SharedSecret.bind(cryptoAdapter),
    aes256GcmEncrypt: cryptoAdapter.aes256GcmEncrypt.bind(cryptoAdapter),
    aes256GcmDecrypt: cryptoAdapter.aes256GcmDecrypt.bind(cryptoAdapter),
    randomBytes: cryptoAdapter.randomBytes.bind(cryptoAdapter),
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

  it('exposes a deterministic challenge-response verifier helper', () => {
    expect(typeof verifyBrokerChallengeResponseControlFrame).toBe('function')
  })

  it('accepts a real Ed25519 challenge-response signature over the Broker-Auth-Transcript', async () => {
    const result = await verifyBrokerChallengeResponseControlFrame({
      frame: brokerVectors.frames.challenge_response,
      pendingChallenge: vectorPendingChallenge(),
      publicKey: hexToBytes(phase1.identity.ed25519_public_hex),
      crypto: cryptoAdapter,
    })

    expect(result).toEqual({
      disposition: 'accepted',
      frame: brokerVectors.frames.challenge_response,
      transcript: brokerVectors.transcript.object,
      signingBytes: hexToBytes(brokerVectors.transcript.jcs_canonical_hex),
    })
  })

  it('verifies the exact canonical transcript bytes and caller-supplied Ed25519 public key bytes', async () => {
    let observedInput: Uint8Array | undefined
    let observedSignature: Uint8Array | undefined
    let observedPublicKey: Uint8Array | undefined
    const crypto = cryptoWithVerify(async (input, signature, publicKey) => {
      observedInput = input
      observedSignature = signature
      observedPublicKey = publicKey
      return true
    })
    const publicKey = hexToBytes(phase1.identity.ed25519_public_hex)

    await expect(verifyBrokerChallengeResponseControlFrame({
      frame: brokerVectors.frames.challenge_response,
      pendingChallenge: vectorPendingChallenge(),
      publicKey,
      crypto,
    })).resolves.toMatchObject({ disposition: 'accepted' })

    expect(bytesToHex(observedInput ?? new Uint8Array())).toBe(brokerVectors.transcript.jcs_canonical_hex)
    expect(bytesToHex(observedSignature ?? new Uint8Array())).toBe(
      brokerVectors.signature.ed25519_signature_hex,
    )
    expect(observedPublicKey).toEqual(publicKey)
  })

  it('classifies tampered transcripts and well-formed invalid signatures as AUTH_INVALID', async () => {
    const invalidSignature = new Uint8Array(hexToBytes(brokerVectors.signature.ed25519_signature_hex))
    invalidSignature[0] ^= 0xff
    const invalidSignatureFrame = {
      ...brokerVectors.frames.challenge_response,
      signature: encodeBase64Url(invalidSignature),
    }

    await expect(verifyBrokerChallengeResponseControlFrame({
      frame: invalidSignatureFrame,
      pendingChallenge: vectorPendingChallenge(),
      publicKey: hexToBytes(phase1.identity.ed25519_public_hex),
      crypto: cryptoAdapter,
    })).resolves.toEqual({
      disposition: 'rejected',
      errorCode: 'AUTH_INVALID',
    })

    await expect(verifyBrokerChallengeResponseControlFrame({
      frame: {
        ...brokerVectors.frames.challenge_response,
        nonce: 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8',
      },
      pendingChallenge: vectorPendingChallenge({
        nonce: 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8',
      }),
      publicKey: hexToBytes(phase1.identity.ed25519_public_hex),
      crypto: cryptoAdapter,
    })).resolves.toEqual({
      disposition: 'rejected',
      errorCode: 'AUTH_INVALID',
    })
  })

  it('rejects pending-challenge binding mismatches as AUTH_INVALID before crypto verification', async () => {
    let verifyCalls = 0
    const crypto = cryptoWithVerify(async () => {
      verifyCalls += 1
      throw new Error('verifyEd25519 must not be called for binding mismatches')
    })

    for (const pendingChallenge of [
      vectorPendingChallenge({ did: 'did:key:z6Mkbob' }),
      vectorPendingChallenge({ deviceId: '123e4567-e89b-42d3-a456-426614174000' }),
      vectorPendingChallenge({ nonce: 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8' }),
    ]) {
      await expect(verifyBrokerChallengeResponseControlFrame({
        frame: brokerVectors.frames.challenge_response,
        pendingChallenge,
        publicKey: hexToBytes(phase1.identity.ed25519_public_hex),
        crypto,
      }), JSON.stringify(pendingChallenge)).resolves.toEqual({
        disposition: 'rejected',
        errorCode: 'AUTH_INVALID',
      })
    }

    expect(verifyCalls).toBe(0)
  })

  it('classifies malformed frame and pending challenge inputs as MALFORMED_MESSAGE', async () => {
    let verifyCalls = 0
    const crypto = cryptoWithVerify(async () => {
      verifyCalls += 1
      throw new Error('verifyEd25519 must not be called for malformed inputs')
    })
    const malformedCases = [
      {
        name: 'malformed frame signature',
        frame: { ...brokerVectors.frames.challenge_response, signature: `${brokerVectors.signature.b64url}=` },
        pendingChallenge: vectorPendingChallenge(),
        publicKey: hexToBytes(phase1.identity.ed25519_public_hex),
      },
      {
        name: 'malformed frame deviceId',
        frame: { ...brokerVectors.frames.challenge_response, deviceId: 'not-a-uuid' },
        pendingChallenge: vectorPendingChallenge(),
        publicKey: hexToBytes(phase1.identity.ed25519_public_hex),
      },
      {
        name: 'malformed pending nonce',
        frame: brokerVectors.frames.challenge_response,
        pendingChallenge: vectorPendingChallenge({ nonce: `${brokerVectors.frames.challenge.nonce}=` }),
        publicKey: hexToBytes(phase1.identity.ed25519_public_hex),
      },
    ] as const

    for (const { name, frame, pendingChallenge, publicKey } of malformedCases) {
      await expect(verifyBrokerChallengeResponseControlFrame({
        frame,
        pendingChallenge,
        publicKey,
        crypto,
      }), name).resolves.toEqual({
        disposition: 'rejected',
        errorCode: 'MALFORMED_MESSAGE',
      })
    }

    expect(verifyCalls).toBe(0)
  })

  it('throws for malformed local verifier inputs before crypto verification', async () => {
    let verifyCalls = 0
    const crypto = cryptoWithVerify(async () => {
      verifyCalls += 1
      throw new Error('verifyEd25519 must not be called for malformed verifier inputs')
    })

    await expect(verifyBrokerChallengeResponseControlFrame({
      frame: brokerVectors.frames.challenge_response,
      pendingChallenge: vectorPendingChallenge(),
      publicKey: new Uint8Array(31),
      crypto,
    })).rejects.toThrow('Invalid broker challenge-response public key')

    await expect(verifyBrokerChallengeResponseControlFrame({
      frame: brokerVectors.frames.challenge_response,
      pendingChallenge: vectorPendingChallenge(),
      publicKey: hexToBytes(phase1.identity.ed25519_public_hex),
      crypto: {} as ProtocolCryptoAdapter,
    })).rejects.toThrow('Invalid broker challenge-response verifier')

    expect(verifyCalls).toBe(0)
  })

  it('propagates verifier adapter faults instead of coercing them to AUTH_INVALID', async () => {
    const crypto = cryptoWithVerify(async () => {
      throw new Error('crypto adapter unavailable')
    })

    await expect(verifyBrokerChallengeResponseControlFrame({
      frame: brokerVectors.frames.challenge_response,
      pendingChallenge: vectorPendingChallenge(),
      publicKey: hexToBytes(phase1.identity.ed25519_public_hex),
      crypto,
    })).rejects.toThrow('crypto adapter unavailable')
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
