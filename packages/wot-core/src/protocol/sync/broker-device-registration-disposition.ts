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

export function evaluateBrokerDeviceRegistrationDisposition(
  input: BrokerDeviceRegistrationDispositionInput,
): BrokerDeviceRegistrationDisposition {
  const hasExactRevokedRegistration = input.deviceList.some((record) =>
    record.did === input.did && record.deviceId === input.deviceId && record.status === 'revoked'
  )
  const hasExactActiveRegistration = input.deviceList.some((record) =>
    record.did === input.did && record.deviceId === input.deviceId && record.status === 'active'
  )

  if (input.revocationWins === true || hasExactRevokedRegistration) {
    return rejectRegistration(input, 'DEVICE_REVOKED')
  }

  const hasConflictingRegistration = input.deviceList.some((record) =>
    record.deviceId === input.deviceId && record.did !== input.did
  )
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
