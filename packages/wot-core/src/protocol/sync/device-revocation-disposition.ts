/**
 * Sync 003 broker/device-revoke (post-signature, known exact device disposition).
 * Spec refs:
 * - wot-spec/03-wot-sync/003-transport-und-broker.md#device-deaktivierung
 * - wot-spec/03-wot-sync/003-transport-und-broker.md#race-conditions
 *
 * NEEDS CLARIFICATION:
 * - unknown-device tombstones / DEVICE_NOT_REGISTERED mapping (wot-spec#32)
 * - malformed deviceId validation semantics (wot-spec#28)
 * - inactive/TTL cleanup policy beyond exact-device cleanup (wot-spec#27)
 */
export type BrokerDeviceStatus = 'active' | 'revoked'

export interface DeviceRevokeSignal {
  type: 'device-revoke'
  did: string
  deviceId: string
  revokedAt: string
}

export interface KnownBrokerDeviceRecord {
  did: string
  deviceId: string
  status: BrokerDeviceStatus
  revokedAt?: string
}

export type DeviceRevocationAction =
  | {
    type: 'mark-device-revoked'
    did: string
    deviceId: string
    revokedAt: string
  }
  | {
    type: 'delete-pending-inbox-messages'
    did: string
    deviceId: string
  }

export type DeviceRevocationDisposition =
  | {
    disposition: 'accepted'
    did: string
    deviceId: string
    revokedAt: string
    actions: DeviceRevocationAction[]
  }
  | {
    disposition: 'accepted-idempotent'
    did: string
    deviceId: string
    revokedAt: string
    actions: DeviceRevocationAction[]
  }
  | {
    disposition: 'not-for-known-device'
    did: string
    deviceId: string
    actions: []
  }

export interface ClassifyDeviceRevocationDispositionInput {
  revocation: DeviceRevokeSignal
  knownDevice: KnownBrokerDeviceRecord
}

export function classifyDeviceRevocationDisposition(
  input: ClassifyDeviceRevocationDispositionInput,
): DeviceRevocationDisposition {
  const { revocation, knownDevice } = input
  if (revocation.did !== knownDevice.did || revocation.deviceId !== knownDevice.deviceId) {
    return {
      disposition: 'not-for-known-device',
      did: revocation.did,
      deviceId: revocation.deviceId,
      actions: [],
    }
  }

  const deletePendingInboxMessages = {
    type: 'delete-pending-inbox-messages',
    did: revocation.did,
    deviceId: revocation.deviceId,
  } satisfies DeviceRevocationAction

  if (knownDevice.status === 'revoked') {
    return {
      disposition: 'accepted-idempotent',
      did: revocation.did,
      deviceId: revocation.deviceId,
      revokedAt: revocation.revokedAt,
      actions: [deletePendingInboxMessages],
    }
  }

  return {
    disposition: 'accepted',
    did: revocation.did,
    deviceId: revocation.deviceId,
    revokedAt: revocation.revokedAt,
    actions: [
      {
        type: 'mark-device-revoked',
        did: revocation.did,
        deviceId: revocation.deviceId,
        revokedAt: revocation.revokedAt,
      },
      deletePendingInboxMessages,
    ],
  }
}
