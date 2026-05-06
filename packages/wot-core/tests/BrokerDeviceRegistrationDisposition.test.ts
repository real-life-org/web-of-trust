import { describe, expect, it } from 'vitest'
import { evaluateBrokerDeviceRegistrationDisposition } from '../src/protocol'
import type {
  BrokerDeviceRegistrationDispositionInput,
  BrokerDeviceRegistrationDeviceRecord,
} from '../src/protocol'

const ALICE_DID = 'did:key:z6Mkalice'
const BOB_DID = 'did:key:z6Mkbob'
const DEVICE_ID = '550e8400-e29b-41d4-a716-446655440000'
const OTHER_DEVICE_ID = '660e8400-e29b-41d4-a716-446655440001'

function activeDevice(
  overrides: Partial<BrokerDeviceRegistrationDeviceRecord> = {},
): BrokerDeviceRegistrationDeviceRecord {
  return {
    did: ALICE_DID,
    deviceId: DEVICE_ID,
    status: 'active',
    ...overrides,
  }
}

function revokedDevice(
  overrides: Partial<BrokerDeviceRegistrationDeviceRecord> = {},
): BrokerDeviceRegistrationDeviceRecord {
  return {
    did: ALICE_DID,
    deviceId: DEVICE_ID,
    status: 'revoked',
    ...overrides,
  }
}

function evaluate(
  overrides: Partial<BrokerDeviceRegistrationDispositionInput> = {},
) {
  return evaluateBrokerDeviceRegistrationDisposition({
    did: ALICE_DID,
    deviceId: DEVICE_ID,
    deviceList: [],
    ...overrides,
  })
}

describe('broker device registration disposition', () => {
  it('registers an already active exact DID/device pair as a known device and drains its device inbox', () => {
    expect(evaluate({
      deviceList: [
        activeDevice(),
        activeDevice({ deviceId: OTHER_DEVICE_ID }),
      ],
    })).toEqual({
      disposition: 'registered',
      did: ALICE_DID,
      deviceId: DEVICE_ID,
      isNewDevice: false,
      actions: [
        {
          type: 'deliver-pending-inbox-messages',
          did: ALICE_DID,
          deviceId: DEVICE_ID,
        },
      ],
    })
  })

  it('registers a first-seen device and returns deterministic broker follow-up actions', () => {
    expect(evaluate({
      deviceList: [activeDevice({ deviceId: OTHER_DEVICE_ID })],
    })).toEqual({
      disposition: 'registered',
      did: ALICE_DID,
      deviceId: DEVICE_ID,
      isNewDevice: true,
      actions: [
        {
          type: 'persist-active-device-registration',
          did: ALICE_DID,
          deviceId: DEVICE_ID,
        },
        {
          type: 'deliver-pending-inbox-messages',
          did: ALICE_DID,
          deviceId: DEVICE_ID,
        },
      ],
    })
  })

  it('rejects a deviceId already registered as active for a different DID', () => {
    expect(evaluate({
      deviceList: [activeDevice({ did: BOB_DID })],
    })).toEqual({
      disposition: 'rejected',
      did: ALICE_DID,
      deviceId: DEVICE_ID,
      errorCode: 'DEVICE_ID_CONFLICT',
      actions: [],
    })
  })

  it('rejects an exact DID/device pair that is already revoked', () => {
    expect(evaluate({
      deviceList: [revokedDevice()],
    })).toEqual({
      disposition: 'rejected',
      did: ALICE_DID,
      deviceId: DEVICE_ID,
      errorCode: 'DEVICE_REVOKED',
      actions: [],
    })
  })

  it('rejects with DEVICE_REVOKED when the caller reports a revocation-wins registration race', () => {
    expect(evaluate({
      deviceList: [],
      revocationWins: true,
    })).toEqual({
      disposition: 'rejected',
      did: ALICE_DID,
      deviceId: DEVICE_ID,
      errorCode: 'DEVICE_REVOKED',
      actions: [],
    })
  })

  it('treats DID and deviceId inputs as already authenticated and syntactically accepted', () => {
    const malformedDid = 'not a did'
    const malformedDeviceId = 'not-a-uuid'

    expect(evaluate({
      did: malformedDid,
      deviceId: malformedDeviceId,
      deviceList: [],
    })).toEqual({
      disposition: 'registered',
      did: malformedDid,
      deviceId: malformedDeviceId,
      isNewDevice: true,
      actions: [
        {
          type: 'persist-active-device-registration',
          did: malformedDid,
          deviceId: malformedDeviceId,
        },
        {
          type: 'deliver-pending-inbox-messages',
          did: malformedDid,
          deviceId: malformedDeviceId,
        },
      ],
    })
  })

  it('models only Sync 003 active and revoked device-list statuses for this slice', () => {
    const statuses = [
      activeDevice().status,
      revokedDevice().status,
    ]

    expect(statuses).toEqual(['active', 'revoked'])
  })
})
