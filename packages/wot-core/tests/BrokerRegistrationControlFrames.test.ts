import { readFileSync } from 'node:fs'
import { beforeEach, describe, expect, it } from 'vitest'
import {
  assertBrokerChallengeControlFrame,
  assertBrokerRegisterControlFrame,
  assertBrokerRegisteredControlFrame,
  createBrokerChallengeControlFrame,
  createBrokerRegisterControlFrame,
  createBrokerRegisteredControlFrame,
  parseBrokerChallengeControlFrame,
  parseBrokerRegisterControlFrame,
  parseBrokerRegisteredControlFrame,
} from '../src/protocol'

const phase1 = JSON.parse(readFileSync(
  './tests/fixtures/wot-spec/phase-1-interop.json',
  'utf8',
))
const brokerVectors = phase1.broker_registration_control_frames
const DID = 'did:key:z6Mkalice'
const DEVICE_ID = '550e8400-e29b-41d4-a716-446655440000'
const NONCE_BYTES = Uint8Array.from({ length: 32 }, (_, index) => index)
const CANONICAL_NONCE = 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8'

function hexToBytes(hex: string): Uint8Array {
  if (hex.length % 2 !== 0) throw new Error('Invalid hex string')
  const bytes = new Uint8Array(hex.length / 2)
  for (let i = 0; i < bytes.length; i++) bytes[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16)
  return bytes
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')
}

function validRegisterFrame(overrides: Record<string, unknown> = {}) {
  return {
    type: 'register',
    did: DID,
    deviceId: DEVICE_ID,
    ...overrides,
  }
}

function validChallengeFrame(overrides: Record<string, unknown> = {}) {
  return {
    type: 'challenge',
    nonce: CANONICAL_NONCE,
    ...overrides,
  }
}

function validRegisteredFrame(overrides: Record<string, unknown> = {}) {
  return {
    type: 'registered',
    did: DID,
    deviceId: DEVICE_ID,
    isNewDevice: true,
    ...overrides,
  }
}

describe('Sync 003 broker registration control frames', () => {
  beforeEach(() => {
    expect(typeof createBrokerRegisterControlFrame).toBe('function')
    expect(typeof parseBrokerRegisterControlFrame).toBe('function')
    expect(typeof assertBrokerRegisterControlFrame).toBe('function')
    expect(typeof createBrokerChallengeControlFrame).toBe('function')
    expect(typeof parseBrokerChallengeControlFrame).toBe('function')
    expect(typeof assertBrokerChallengeControlFrame).toBe('function')
    expect(typeof createBrokerRegisteredControlFrame).toBe('function')
    expect(typeof parseBrokerRegisteredControlFrame).toBe('function')
    expect(typeof assertBrokerRegisteredControlFrame).toBe('function')
  })

  it('constructs and parses a deterministic register control-frame', () => {
    const frame = createBrokerRegisterControlFrame({
      did: DID,
      deviceId: DEVICE_ID,
    })

    expect(frame).toEqual(validRegisterFrame())
    expect(parseBrokerRegisterControlFrame(frame)).toEqual(frame)
    expect(() => assertBrokerRegisterControlFrame(frame)).not.toThrow()
  })

  it('constructs and parses a deterministic challenge control-frame with nonce byte roundtrip', () => {
    const frame = createBrokerChallengeControlFrame({
      nonce: NONCE_BYTES,
    })

    expect(frame).toEqual(validChallengeFrame())
    expect(parseBrokerChallengeControlFrame(frame)).toEqual({
      type: 'challenge',
      nonce: CANONICAL_NONCE,
      nonceBytes: NONCE_BYTES,
    })
    expect(() => assertBrokerChallengeControlFrame(frame)).not.toThrow()
  })

  it('constructs and parses deterministic registered control-frames for new and known devices', () => {
    const newDeviceFrame = createBrokerRegisteredControlFrame({
      did: DID,
      deviceId: DEVICE_ID,
      isNewDevice: true,
    })
    const knownDeviceFrame = createBrokerRegisteredControlFrame({
      did: DID,
      deviceId: DEVICE_ID,
      isNewDevice: false,
    })

    expect(newDeviceFrame).toEqual(validRegisteredFrame())
    expect(knownDeviceFrame).toEqual(validRegisteredFrame({ isNewDevice: false }))
    expect(parseBrokerRegisteredControlFrame(newDeviceFrame)).toEqual(newDeviceFrame)
    expect(parseBrokerRegisteredControlFrame(knownDeviceFrame)).toEqual(knownDeviceFrame)
    expect(() => assertBrokerRegisteredControlFrame(newDeviceFrame)).not.toThrow()
  })

  it('matches the phase-1 interop vectors for register, challenge, and registered control-frames', () => {
    const nonceBytes = hexToBytes(brokerVectors.nonce.bytes_hex)

    expect(createBrokerRegisterControlFrame({
      did: brokerVectors.frames.register.did,
      deviceId: brokerVectors.frames.register.deviceId,
    })).toEqual(brokerVectors.frames.register)
    expect(parseBrokerRegisterControlFrame(brokerVectors.frames.register)).toEqual(
      brokerVectors.frames.register,
    )

    expect(createBrokerChallengeControlFrame({ nonce: nonceBytes })).toEqual(
      brokerVectors.frames.challenge,
    )
    const parsedChallenge = parseBrokerChallengeControlFrame(brokerVectors.frames.challenge)
    expect(parsedChallenge).toEqual({
      ...brokerVectors.frames.challenge,
      nonceBytes,
    })
    expect(parsedChallenge.nonce).toBe(brokerVectors.nonce.b64url)
    expect(bytesToHex(parsedChallenge.nonceBytes)).toBe(brokerVectors.nonce.bytes_hex)

    expect(createBrokerRegisteredControlFrame({
      did: brokerVectors.frames.registered.did,
      deviceId: brokerVectors.frames.registered.deviceId,
      isNewDevice: brokerVectors.frames.registered.isNewDevice,
    })).toEqual(brokerVectors.frames.registered)
    expect(parseBrokerRegisteredControlFrame(brokerVectors.frames.registered)).toEqual(
      brokerVectors.frames.registered,
    )
  })

  it('rejects malformed or missing register fields before broker state is consulted', () => {
    const invalidFrames = [
      ['non-object frame', null],
      ['missing type', { did: DID, deviceId: DEVICE_ID }],
      ['wrong type', validRegisterFrame({ type: 'challenge' })],
      ['missing did', { type: 'register', deviceId: DEVICE_ID }],
      ['empty did', validRegisterFrame({ did: '' })],
      ['numeric did', validRegisterFrame({ did: 123 })],
      ['missing deviceId', { type: 'register', did: DID }],
      ['uppercase deviceId', validRegisterFrame({
        deviceId: '550E8400-E29B-41D4-A716-446655440000',
      })],
      ['non-v4 deviceId', validRegisterFrame({
        deviceId: '550e8400-e29b-11d4-a716-446655440000',
      })],
      ['invalid deviceId', validRegisterFrame({ deviceId: 'not-a-uuid' })],
    ] as const

    for (const [name, frame] of invalidFrames) {
      expect(() => parseBrokerRegisterControlFrame(frame), name).toThrow()
    }
  })

  it('rejects malformed or missing challenge fields before nonce storage is consulted', () => {
    const invalidFrames = [
      ['non-object frame', null],
      ['missing type', { nonce: CANONICAL_NONCE }],
      ['wrong type', validChallengeFrame({ type: 'registered' })],
      ['missing nonce', { type: 'challenge' }],
      ['empty nonce', validChallengeFrame({ nonce: '' })],
      ['padded nonce', validChallengeFrame({ nonce: `${CANONICAL_NONCE}=` })],
      ['standard Base64 plus nonce', validChallengeFrame({ nonce: 'not+base64url' })],
      ['standard Base64 slash nonce', validChallengeFrame({ nonce: 'not/base64url' })],
      ['wrong short length nonce', validChallengeFrame({
        nonce: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
      })],
      ['wrong long length nonce', validChallengeFrame({
        nonce: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
      })],
      ['non-string nonce', validChallengeFrame({ nonce: NONCE_BYTES })],
      ['non-canonical nonce', validChallengeFrame({
        nonce: `${CANONICAL_NONCE.slice(0, -1)}9`,
      })],
    ] as const

    for (const [name, frame] of invalidFrames) {
      expect(() => parseBrokerChallengeControlFrame(frame), name).toThrow()
    }
  })

  it('rejects malformed or missing registered fields before device-list persistence is consulted', () => {
    const invalidFrames = [
      ['non-object frame', null],
      ['missing type', { did: DID, deviceId: DEVICE_ID, isNewDevice: true }],
      ['wrong type', validRegisteredFrame({ type: 'register' })],
      ['missing did', { type: 'registered', deviceId: DEVICE_ID, isNewDevice: true }],
      ['empty did', validRegisteredFrame({ did: '' })],
      ['numeric did', validRegisteredFrame({ did: 123 })],
      ['missing deviceId', { type: 'registered', did: DID, isNewDevice: true }],
      ['uppercase deviceId', validRegisteredFrame({
        deviceId: '550E8400-E29B-41D4-A716-446655440000',
      })],
      ['non-v4 deviceId', validRegisteredFrame({
        deviceId: '550e8400-e29b-11d4-a716-446655440000',
      })],
      ['invalid deviceId', validRegisteredFrame({ deviceId: 'not-a-uuid' })],
      ['missing isNewDevice', { type: 'registered', did: DID, deviceId: DEVICE_ID }],
      ['string isNewDevice', validRegisteredFrame({ isNewDevice: 'true' })],
      ['null isNewDevice', validRegisteredFrame({ isNewDevice: null })],
    ] as const

    for (const [name, frame] of invalidFrames) {
      expect(() => parseBrokerRegisteredControlFrame(frame), name).toThrow()
    }
  })

  it('rejects inherited required fields on registration control-frames', () => {
    const inheritedRegisterType = Object.create({ type: 'register' })
    inheritedRegisterType.did = DID
    inheritedRegisterType.deviceId = DEVICE_ID

    const inheritedChallengeNonce = Object.create({ nonce: CANONICAL_NONCE })
    inheritedChallengeNonce.type = 'challenge'

    const inheritedRegisteredDeviceId = Object.create({ deviceId: DEVICE_ID })
    inheritedRegisteredDeviceId.type = 'registered'
    inheritedRegisteredDeviceId.did = DID
    inheritedRegisteredDeviceId.isNewDevice = true

    expect(() => parseBrokerRegisterControlFrame(inheritedRegisterType)).toThrow()
    expect(() => parseBrokerChallengeControlFrame(inheritedChallengeNonce)).toThrow()
    expect(() => parseBrokerRegisteredControlFrame(inheritedRegisteredDeviceId)).toThrow()
  })

  it('rejects unknown top-level fields for the closed registration control-frame shapes', () => {
    expect(() => parseBrokerRegisterControlFrame(validRegisterFrame({
      brokerTraceId: 'trace-123',
    }))).toThrow()
    expect(() => parseBrokerChallengeControlFrame(validChallengeFrame({
      expiresAt: '2026-04-22T10:00:00Z',
    }))).toThrow()
    expect(() => parseBrokerRegisteredControlFrame(validRegisteredFrame({
      lastSeenAt: '2026-04-22T10:00:00Z',
    }))).toThrow()

    const nonEnumerableRegister = validRegisterFrame()
    Object.defineProperty(nonEnumerableRegister, 'hiddenTraceId', {
      value: 'trace-123',
      enumerable: false,
    })
    expect(() => parseBrokerRegisterControlFrame(nonEnumerableRegister)).toThrow()

    const symbolChallenge = validChallengeFrame()
    Object.defineProperty(symbolChallenge, Symbol('trace'), {
      value: 'trace-123',
      enumerable: true,
    })
    expect(() => parseBrokerChallengeControlFrame(symbolChallenge)).toThrow()
  })

  it('rejects unknown control-frame types instead of treating them as extension semantics', () => {
    for (const type of ['challenge-response', 'device-revoke', 'error/1.0', 'register/1.0']) {
      expect(() => parseBrokerRegisterControlFrame(validRegisterFrame({ type })), `register ${type}`).toThrow()
      expect(() => parseBrokerChallengeControlFrame(validChallengeFrame({ type })), `challenge ${type}`).toThrow()
      expect(() => parseBrokerRegisteredControlFrame(validRegisteredFrame({ type })), `registered ${type}`).toThrow()
    }
  })

  it('rejects WoT Transport Envelope fields because registration frames are Broker Control-Frames', () => {
    for (const forbiddenField of ['id', 'typ', 'from', 'to', 'created_time']) {
      const forbiddenValue = forbiddenField === 'to' ? ['did:key:z6Mkbob'] : 'forbidden'

      expect(() =>
        parseBrokerRegisterControlFrame(validRegisterFrame({
          [forbiddenField]: forbiddenValue,
        })),
      `register ${forbiddenField}`).toThrow()
      expect(() =>
        parseBrokerChallengeControlFrame(validChallengeFrame({
          [forbiddenField]: forbiddenValue,
        })),
      `challenge ${forbiddenField}`).toThrow()
      expect(() =>
        parseBrokerRegisteredControlFrame(validRegisteredFrame({
          [forbiddenField]: forbiddenValue,
        })),
      `registered ${forbiddenField}`).toThrow()
    }
  })
})
