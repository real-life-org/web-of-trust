/**
 * Sync 003 broker/device-revoke (post-signature disposition).
 * Spec refs:
 * - wot-spec/03-wot-sync/003-transport-und-broker.md#device-deaktivierung
 * - wot-spec/03-wot-sync/003-transport-und-broker.md#device-liste-im-broker
 * - wot-spec/03-wot-sync/003-transport-und-broker.md#race-conditions
 */
export type BrokerDeviceStatus = 'active' | 'revoked'

export type DeviceRevocationErrorCode = 'DEVICE_ID_CONFLICT' | 'MALFORMED_MESSAGE'

export interface DeviceRevokePayload {
  type: 'device-revoke'
  did: string
  deviceId: string
  revokedAt: string
}

export interface DeviceRevocationDeviceRecord {
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
  | {
    type: 'persist-revoked-device-tombstone'
    did: string
    deviceId: string
    revokedAt: string
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
    disposition: 'accepted-tombstone'
    did: string
    deviceId: string
    revokedAt: string
    actions: DeviceRevocationAction[]
  }
  | {
    disposition: 'rejected'
    did?: string
    deviceId?: string
    errorCode: DeviceRevocationErrorCode
    actions: []
  }
  | {
    disposition: 'not-for-known-device'
    did: string
    deviceId: string
    actions: []
  }

export type DeviceRevokePayloadValidation =
  | {
    valid: true
    payload: DeviceRevokePayload
  }
  | {
    valid: false
    errorCode: 'MALFORMED_MESSAGE'
  }

export interface DeviceRevocationDispositionInput {
  decodedPayload: unknown
  deviceList: readonly DeviceRevocationDeviceRecord[]
}

export interface ClassifyDeviceRevocationDispositionInput {
  revocation: DeviceRevokePayload
  knownDevice: DeviceRevocationDeviceRecord
}

export type DeviceRevokeSignal = DeviceRevokePayload
export type KnownBrokerDeviceRecord = DeviceRevocationDeviceRecord

const CANONICAL_UUID_V4_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

const RFC3339_DATE_TIME_WITH_TIMEZONE_PATTERN =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(Z|[+-]\d{2}:\d{2})$/

export function validateDeviceRevokePayload(payload: unknown): DeviceRevokePayloadValidation {
  if (!isRecord(payload)) return malformedDeviceRevokePayload()

  if (
    payload.type !== 'device-revoke'
    || typeof payload.did !== 'string'
    || payload.did.length === 0
    || typeof payload.deviceId !== 'string'
    || !CANONICAL_UUID_V4_PATTERN.test(payload.deviceId)
    || typeof payload.revokedAt !== 'string'
    || !isValidRfc3339DateTimeWithExplicitTimezone(payload.revokedAt)
  ) {
    return malformedDeviceRevokePayload()
  }

  return {
    valid: true,
    payload: {
      type: payload.type,
      did: payload.did,
      deviceId: payload.deviceId,
      revokedAt: payload.revokedAt,
    },
  }
}

export function evaluateDeviceRevocationDisposition(
  input: DeviceRevocationDispositionInput,
): DeviceRevocationDisposition {
  const validation = validateDeviceRevokePayload(input.decodedPayload)
  if (!validation.valid) {
    return {
      disposition: 'rejected',
      errorCode: validation.errorCode,
      actions: [],
    }
  }

  const revocation = validation.payload
  let exactDevice: DeviceRevocationDeviceRecord | undefined
  let hasForeignDeviceIdRecord = false

  for (const record of input.deviceList) {
    if (record.deviceId !== revocation.deviceId) continue

    if (record.did !== revocation.did) {
      hasForeignDeviceIdRecord = true
      continue
    }

    if (record.status === 'revoked') {
      if (exactDevice === undefined || exactDevice.status !== 'revoked') exactDevice = record
      continue
    }

    if (exactDevice === undefined) exactDevice = record
  }

  if (hasForeignDeviceIdRecord) {
    return {
      disposition: 'rejected',
      did: revocation.did,
      deviceId: revocation.deviceId,
      errorCode: 'DEVICE_ID_CONFLICT',
      actions: [],
    }
  }

  if (exactDevice?.status === 'revoked') {
    return {
      disposition: 'accepted-idempotent',
      did: revocation.did,
      deviceId: revocation.deviceId,
      revokedAt: exactDevice.revokedAt ?? revocation.revokedAt,
      actions: [],
    }
  }

  if (exactDevice?.status === 'active') {
    return {
      disposition: 'accepted',
      did: revocation.did,
      deviceId: revocation.deviceId,
      revokedAt: revocation.revokedAt,
      actions: [
        markDeviceRevoked(revocation),
        deletePendingInboxMessages(revocation),
      ],
    }
  }

  return {
    disposition: 'accepted-tombstone',
    did: revocation.did,
    deviceId: revocation.deviceId,
    revokedAt: revocation.revokedAt,
    actions: [
      {
        type: 'persist-revoked-device-tombstone',
        did: revocation.did,
        deviceId: revocation.deviceId,
        revokedAt: revocation.revokedAt,
      },
    ],
  }
}

/**
 * Legacy narrow wrapper for callers that already selected one exact known
 * broker device record. It mirrors the Sync 003 idempotency rule used by
 * `evaluateDeviceRevocationDisposition`: duplicate revocations preserve the
 * first stored `revokedAt` and do not require another inbox cleanup action.
 */
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

  if (knownDevice.status === 'revoked') {
    return {
      disposition: 'accepted-idempotent',
      did: revocation.did,
      deviceId: revocation.deviceId,
      revokedAt: knownDevice.revokedAt ?? revocation.revokedAt,
      actions: [],
    }
  }

  return {
    disposition: 'accepted',
    did: revocation.did,
    deviceId: revocation.deviceId,
    revokedAt: revocation.revokedAt,
    actions: [
      markDeviceRevoked(revocation),
      deletePendingInboxMessages(revocation),
    ],
  }
}

function markDeviceRevoked(revocation: DeviceRevokePayload): DeviceRevocationAction {
  return {
    type: 'mark-device-revoked',
    did: revocation.did,
    deviceId: revocation.deviceId,
    revokedAt: revocation.revokedAt,
  }
}

function deletePendingInboxMessages(
  revocation: Pick<DeviceRevokePayload, 'did' | 'deviceId'>,
): DeviceRevocationAction {
  return {
    type: 'delete-pending-inbox-messages',
    did: revocation.did,
    deviceId: revocation.deviceId,
  }
}

function malformedDeviceRevokePayload(): DeviceRevokePayloadValidation {
  return {
    valid: false,
    errorCode: 'MALFORMED_MESSAGE',
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isValidRfc3339DateTimeWithExplicitTimezone(value: string): boolean {
  const match = RFC3339_DATE_TIME_WITH_TIMEZONE_PATTERN.exec(value)
  if (match === null) return false

  const [, yearText, monthText, dayText, hourText, minuteText, secondText, timezone] = match
  const year = Number(yearText)
  const month = Number(monthText)
  const day = Number(dayText)
  const hour = Number(hourText)
  const minute = Number(minuteText)
  const second = Number(secondText)

  if (
    month < 1 || month > 12
    || day < 1 || day > daysInMonth(year, month)
    || hour > 23
    || minute > 59
    || second > 59
  ) {
    return false
  }

  if (timezone !== 'Z') {
    const timezoneHour = Number(timezone.slice(1, 3))
    const timezoneMinute = Number(timezone.slice(4, 6))
    if (timezoneHour > 23 || timezoneMinute > 59) return false
  }

  return true
}

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate()
}
