import { describe, expect, it } from 'vitest'
import { classifyDeviceRevocationDisposition } from '../src/protocol'
import type {
  DeviceRevokeSignal,
  KnownBrokerDeviceRecord,
} from '../src/protocol'

const DID = 'did:key:z6Mkalice'
const OTHER_DID = 'did:key:z6Mkbob'
const DEVICE_ID = '550e8400-e29b-41d4-a716-446655440000'
const OTHER_DEVICE_ID = '123e4567-e89b-42d3-a456-426614174000'
const FIRST_SEEN_AT = '2026-04-20T08:00:00Z'
const LAST_SEEN_AT = '2026-04-22T09:59:00Z'
const REVOKED_AT = 'not-validated-in-this-slice'

function revocation(overrides: Partial<DeviceRevokeSignal> = {}): DeviceRevokeSignal {
  return {
    type: 'device-revoke',
    did: DID,
    deviceId: DEVICE_ID,
    revokedAt: REVOKED_AT,
    ...overrides,
  }
}

function knownDevice(overrides: Partial<KnownBrokerDeviceRecord> = {}): KnownBrokerDeviceRecord {
  return {
    did: DID,
    deviceId: DEVICE_ID,
    firstSeenAt: FIRST_SEEN_AT,
    lastSeenAt: LAST_SEEN_AT,
    status: 'active',
    ...overrides,
  }
}

describe('device revocation disposition invariants', () => {
  it('accepts a signature-verified revocation for the known active exact device and returns deterministic follow-up actions', () => {
    expect(classifyDeviceRevocationDisposition({
      revocation: revocation(),
      knownDevice: knownDevice(),
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

  it('treats an already-revoked exact device as idempotently accepted without overwriting revocation metadata', () => {
    expect(classifyDeviceRevocationDisposition({
      revocation: revocation({ revokedAt: '2026-04-23T12:00:00Z' }),
      knownDevice: knownDevice({
        status: 'revoked',
        revokedAt: '2026-04-22T10:00:00Z',
      }),
    })).toEqual({
      disposition: 'accepted-idempotent',
      did: DID,
      deviceId: DEVICE_ID,
      revokedAt: '2026-04-23T12:00:00Z',
      actions: [
        {
          type: 'delete-pending-inbox-messages',
          did: DID,
          deviceId: DEVICE_ID,
        },
      ],
    })
  })

  it('scopes every cleanup action to the exact revocation did and deviceId tuple only', () => {
    const disposition = classifyDeviceRevocationDisposition({
      revocation: revocation(),
      knownDevice: knownDevice(),
    })

    expect(disposition.actions).toContainEqual({
      type: 'delete-pending-inbox-messages',
      did: DID,
      deviceId: DEVICE_ID,
    })
    expect(disposition.actions).not.toContainEqual(expect.objectContaining({
      did: OTHER_DID,
    }))
    expect(disposition.actions).not.toContainEqual(expect.objectContaining({
      deviceId: OTHER_DEVICE_ID,
    }))
  })

  it('does not parse or normalize revokedAt before carrying it into the disposition', () => {
    const disposition = classifyDeviceRevocationDisposition({
      revocation: revocation({ revokedAt: '2026-02-31T25:61:00Z' }),
      knownDevice: knownDevice(),
    })

    expect(disposition.revokedAt).toBe('2026-02-31T25:61:00Z')
    expect(disposition.actions).toContainEqual({
      type: 'mark-device-revoked',
      did: DID,
      deviceId: DEVICE_ID,
      revokedAt: '2026-02-31T25:61:00Z',
    })
  })

  it('is a pure protocol decision and leaves caller-owned broker records untouched', () => {
    const record = knownDevice()
    const snapshot = structuredClone(record)

    classifyDeviceRevocationDisposition({
      revocation: revocation(),
      knownDevice: record,
    })

    expect(record).toEqual(snapshot)
  })

  it('keeps unknown-device and malformed-message policy outside this slice', () => {
    // wot-spec#32 owns unknown-device tombstones, DEVICE_NOT_REGISTERED, malformed
    // device-revoke errors, invalid signatures, and signer-DID mismatch mapping.
    // wot-spec#27 owns inactive/TTL/pending-inbox policy beyond immediate exact-device cleanup.
    // wot-spec#28 owns malformed deviceId and device-revoke.deviceId validation semantics.
    expect(classifyDeviceRevocationDisposition({
      revocation: revocation({ deviceId: OTHER_DEVICE_ID }),
      knownDevice: knownDevice(),
    })).toEqual({
      disposition: 'not-for-known-device',
      did: DID,
      deviceId: OTHER_DEVICE_ID,
      actions: [],
    })
  })
})
