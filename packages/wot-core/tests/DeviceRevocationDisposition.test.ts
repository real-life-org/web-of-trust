import { describe, expect, it } from 'vitest'
import {
  evaluateDeviceRevocationDisposition,
  validateDeviceRevokePayload,
} from '../src/protocol'
import type {
  DeviceRevokePayload,
  DeviceRevocationDeviceRecord,
  DeviceRevocationDispositionInput,
} from '../src/protocol'

const DID = 'did:key:z6Mkalice'
const OTHER_DID = 'did:key:z6Mkbob'
const DEVICE_ID = '550e8400-e29b-41d4-a716-446655440000'
const OTHER_DEVICE_ID = '123e4567-e89b-42d3-a456-426614174000'
const REVOKED_AT = '2026-04-22T10:00:00Z'

function revocation(overrides: Partial<DeviceRevokePayload> = {}): DeviceRevokePayload {
  return {
    type: 'device-revoke',
    did: DID,
    deviceId: DEVICE_ID,
    revokedAt: REVOKED_AT,
    ...overrides,
  }
}

function activeDevice(
  overrides: Partial<DeviceRevocationDeviceRecord> = {},
): DeviceRevocationDeviceRecord {
  return {
    did: DID,
    deviceId: DEVICE_ID,
    status: 'active',
    ...overrides,
  }
}

function revokedDevice(
  overrides: Partial<DeviceRevocationDeviceRecord> = {},
): DeviceRevocationDeviceRecord {
  return {
    did: DID,
    deviceId: DEVICE_ID,
    status: 'revoked',
    revokedAt: '2026-04-21T09:30:00Z',
    ...overrides,
  }
}

function evaluate(
  overrides: Partial<DeviceRevocationDispositionInput> = {},
) {
  return evaluateDeviceRevocationDisposition({
    decodedPayload: revocation(),
    deviceList: [],
    ...overrides,
  })
}

describe('device-revoke decoded payload validation', () => {
  it('accepts the exact Sync 003 decoded payload shape after JWS verification has already succeeded', () => {
    expect(validateDeviceRevokePayload(revocation())).toEqual({
      valid: true,
      payload: revocation(),
    })
  })

  it.each([
    ['wrong type', { ...revocation(), type: 'device-revoked' }],
    ['empty did', { ...revocation(), did: '' }],
    ['non-string did', { ...revocation(), did: 42 }],
    ['non-v4 deviceId', { ...revocation(), deviceId: '550e8400-e29b-11d4-a716-446655440000' }],
    ['uppercase deviceId', { ...revocation(), deviceId: '550E8400-E29B-41D4-A716-446655440000' }],
    ['missing revokedAt timezone', { ...revocation(), revokedAt: '2026-04-22T10:00:00' }],
    ['invalid revokedAt date-time', { ...revocation(), revokedAt: '2026-02-31T25:61:00Z' }],
  ])('classifies malformed decoded payloads as MALFORMED_MESSAGE: %s', (_label, payload) => {
    expect(validateDeviceRevokePayload(payload)).toEqual({
      valid: false,
      errorCode: 'MALFORMED_MESSAGE',
    })
  })
})

describe('device-revoke broker disposition', () => {
  it('accepts a verified revocation for a known active exact device and returns deterministic follow-up actions', () => {
    expect(evaluate({
      deviceList: [
        activeDevice(),
        activeDevice({ deviceId: OTHER_DEVICE_ID }),
      ],
    })).toEqual({
      disposition: 'accepted',
      did: DID,
      deviceId: DEVICE_ID,
      revokedAt: REVOKED_AT,
      actions: [
        {
          type: 'mark-device-revoked',
          did: DID,
          deviceId: DEVICE_ID,
          revokedAt: REVOKED_AT,
        },
        {
          type: 'delete-pending-inbox-messages',
          did: DID,
          deviceId: DEVICE_ID,
        },
      ],
    })
  })

  it('preserves the first stored revocation metadata for an already-revoked exact device', () => {
    expect(evaluate({
      decodedPayload: revocation({ revokedAt: '2026-04-23T12:00:00Z' }),
      deviceList: [
        revokedDevice({ revokedAt: '2026-04-21T09:30:00Z' }),
      ],
    })).toEqual({
      disposition: 'accepted-idempotent',
      did: DID,
      deviceId: DEVICE_ID,
      revokedAt: '2026-04-21T09:30:00Z',
      actions: [],
    })
  })

  it('accepts an unknown exact DID/device pair as a revoked tombstone when no foreign record owns the deviceId', () => {
    expect(evaluate({
      deviceList: [
        activeDevice({ deviceId: OTHER_DEVICE_ID }),
      ],
    })).toEqual({
      disposition: 'accepted-tombstone',
      did: DID,
      deviceId: DEVICE_ID,
      revokedAt: REVOKED_AT,
      actions: [
        {
          type: 'persist-revoked-device-tombstone',
          did: DID,
          deviceId: DEVICE_ID,
          revokedAt: REVOKED_AT,
        },
      ],
    })
  })

  it('rejects a revocation whose deviceId is already registered to another DID and does not create a signer tombstone', () => {
    expect(evaluate({
      deviceList: [
        activeDevice({ did: OTHER_DID }),
      ],
    })).toEqual({
      disposition: 'rejected',
      did: DID,
      deviceId: DEVICE_ID,
      errorCode: 'DEVICE_ID_CONFLICT',
      actions: [],
    })
  })

  it('classifies malformed decoded payloads before disposition without inventing crypto results', () => {
    expect(evaluate({
      decodedPayload: {
        type: 'device-revoke',
        did: DID,
        deviceId: 'not-a-uuid',
        revokedAt: REVOKED_AT,
      },
      deviceList: [activeDevice()],
    })).toEqual({
      disposition: 'rejected',
      errorCode: 'MALFORMED_MESSAGE',
      actions: [],
    })
  })

  it('is a pure protocol decision and leaves caller-owned broker records untouched', () => {
    const records = [activeDevice()]
    const snapshot = structuredClone(records)

    evaluate({
      deviceList: records,
    })

    expect(records).toEqual(snapshot)
  })
})
