export type BrokerDeviceRegistrationDeviceStatus = 'active' | 'revoked'

export type BrokerDeviceRegistrationErrorCode = 'DEVICE_ID_CONFLICT' | 'DEVICE_REVOKED'

export type BrokerDeviceRegistrationAction =
  | BrokerDeviceRegistrationPersistActiveDeviceAction
  | BrokerDeviceRegistrationDeliverPendingInboxMessagesAction

export interface BrokerDeviceRegistrationDeviceRecord {
  did: string
  deviceId: string
  status: BrokerDeviceRegistrationDeviceStatus
}

export interface BrokerDeviceRegistrationDispositionInput {
  did: string
  deviceId: string
  deviceList: readonly BrokerDeviceRegistrationDeviceRecord[]
  revocationWins?: boolean
}

export interface BrokerDeviceRegistrationPersistActiveDeviceAction {
  type: 'persist-active-device-registration'
  did: string
  deviceId: string
}

export interface BrokerDeviceRegistrationDeliverPendingInboxMessagesAction {
  type: 'deliver-pending-inbox-messages'
  did: string
  deviceId: string
}

export interface BrokerDeviceRegistrationRegisteredDisposition {
  disposition: 'registered'
  did: string
  deviceId: string
  isNewDevice: boolean
  actions: readonly BrokerDeviceRegistrationAction[]
}

export interface BrokerDeviceRegistrationRejectedDisposition {
  disposition: 'rejected'
  did: string
  deviceId: string
  errorCode: BrokerDeviceRegistrationErrorCode
  actions: readonly []
}

export type BrokerDeviceRegistrationDisposition =
  | BrokerDeviceRegistrationRegisteredDisposition
  | BrokerDeviceRegistrationRejectedDisposition

/**
 * Sync 003 "Device-Registrierung" and "Race Conditions":
 * post-authenticated registration disposition for accepted `(did, deviceId)` inputs.
 */
export function evaluateBrokerDeviceRegistrationDisposition(
  input: BrokerDeviceRegistrationDispositionInput,
): BrokerDeviceRegistrationDisposition {
  let hasExactRevokedRegistration = false
  let hasExactActiveRegistration = false
  let hasConflictingRegistration = false

  for (const record of input.deviceList) {
    if (record.deviceId !== input.deviceId) continue

    if (record.did !== input.did) {
      // [NEEDS CLARIFICATION: real-life-org/wot-spec#29] Sync 003 requires
      // globally unique device IDs; until revoked foreign reuse is clarified,
      // retained foreign records are treated as conflict tombstones.
      hasConflictingRegistration = true
      continue
    }

    if (record.status === 'revoked') {
      hasExactRevokedRegistration = true
      break
    }

    hasExactActiveRegistration = true
  }

  if (input.revocationWins === true || hasExactRevokedRegistration) {
    return rejectRegistration(input, 'DEVICE_REVOKED')
  }

  if (hasConflictingRegistration) return rejectRegistration(input, 'DEVICE_ID_CONFLICT')

  if (hasExactActiveRegistration) {
    return {
      disposition: 'registered',
      did: input.did,
      deviceId: input.deviceId,
      isNewDevice: false,
      actions: [deliverPendingInboxMessages(input)],
    }
  }

  return {
    disposition: 'registered',
    did: input.did,
    deviceId: input.deviceId,
    isNewDevice: true,
    actions: [
      {
        type: 'persist-active-device-registration',
        did: input.did,
        deviceId: input.deviceId,
      },
      deliverPendingInboxMessages(input),
    ],
  }
}

function rejectRegistration(
  input: Pick<BrokerDeviceRegistrationDispositionInput, 'did' | 'deviceId'>,
  errorCode: BrokerDeviceRegistrationErrorCode,
): BrokerDeviceRegistrationRejectedDisposition {
  return {
    disposition: 'rejected',
    did: input.did,
    deviceId: input.deviceId,
    errorCode,
    actions: [],
  }
}

function deliverPendingInboxMessages(
  input: Pick<BrokerDeviceRegistrationDispositionInput, 'did' | 'deviceId'>,
): BrokerDeviceRegistrationDeliverPendingInboxMessagesAction {
  return {
    type: 'deliver-pending-inbox-messages',
    did: input.did,
    deviceId: input.deviceId,
  }
}
