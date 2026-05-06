const INACTIVE_DEVICE_CLARIFICATION_NOTE =
  '[NEEDS CLARIFICATION: wot-spec #27] inactive-device, TTL, and long-offline GC semantics are not implemented here.' as const

export type BrokerInboxDeviceStatus = 'active' | 'revoked' | 'deactivated'

export interface BrokerInboxAuthenticatedDevice {
  did: string
  deviceId: string
}

export interface BrokerInboxDevice extends BrokerInboxAuthenticatedDevice {
  status: BrokerInboxDeviceStatus
}

export interface BrokerInboxEntry extends BrokerInboxAuthenticatedDevice {
  messageId: string
  acked: boolean
}

export type BrokerInboxCleanupReason = 'device-revoked' | 'device-deactivated'

export interface BrokerInboxCleanupGuidance extends BrokerInboxAuthenticatedDevice {
  reason: BrokerInboxCleanupReason
  note: typeof INACTIVE_DEVICE_CLARIFICATION_NOTE
}

export interface BrokerInboxExcludedSenderTarget extends BrokerInboxAuthenticatedDevice {
  reason: 'self-addressed-sender-excluded'
}

export interface ComputeBrokerInboxDeliveryTargetsInput {
  messageId: string
  sender: BrokerInboxAuthenticatedDevice
  recipientDid: string
  recipientDevices: readonly BrokerInboxDevice[]
}

export interface BrokerInboxDeliveryDisposition {
  deliveryTargets: BrokerInboxEntry[]
  cleanupPendingEntriesFor: BrokerInboxCleanupGuidance[]
  excludedSenderTarget?: BrokerInboxExcludedSenderTarget
  fullyDelivered: boolean
}

export interface ApplyBrokerInboxAckInput {
  authenticatedDevice: BrokerInboxAuthenticatedDevice
  messageId: string
  entries: readonly BrokerInboxEntry[]
}

export interface BrokerInboxAckDisposition {
  ackApplied: boolean
  entries: BrokerInboxEntry[]
  fullyDelivered: boolean
}

export function computeBrokerInboxDeliveryTargets(
  input: ComputeBrokerInboxDeliveryTargetsInput,
): BrokerInboxDeliveryDisposition {
  const deliveryTargets: BrokerInboxEntry[] = []
  const cleanupPendingEntriesFor: BrokerInboxCleanupGuidance[] = []
  let excludedSenderTarget: BrokerInboxExcludedSenderTarget | undefined

  for (const device of input.recipientDevices) {
    if (device.did !== input.recipientDid) continue

    if (device.status === 'revoked') {
      cleanupPendingEntriesFor.push(cleanupGuidance(device, 'device-revoked'))
      continue
    }

    if (device.status === 'deactivated') {
      cleanupPendingEntriesFor.push(cleanupGuidance(device, 'device-deactivated'))
      continue
    }

    if (input.sender.did === input.recipientDid && device.deviceId === input.sender.deviceId) {
      excludedSenderTarget = {
        did: device.did,
        deviceId: device.deviceId,
        reason: 'self-addressed-sender-excluded',
      }
      continue
    }

    deliveryTargets.push({
      did: device.did,
      deviceId: device.deviceId,
      messageId: input.messageId,
      acked: false,
    })
  }

  return {
    deliveryTargets,
    cleanupPendingEntriesFor,
    ...(excludedSenderTarget ? { excludedSenderTarget } : {}),
    fullyDelivered: deliveryTargets.length === 0,
  }
}

export function applyBrokerInboxAck(input: ApplyBrokerInboxAckInput): BrokerInboxAckDisposition {
  let ackApplied = false
  const entries = input.entries.map((entry) => {
    if (
      entry.messageId !== input.messageId
      || entry.did !== input.authenticatedDevice.did
      || entry.deviceId !== input.authenticatedDevice.deviceId
    ) {
      return { ...entry }
    }

    ackApplied = true
    return {
      ...entry,
      acked: true,
    }
  })

  const messageEntries = entries.filter((entry) => entry.messageId === input.messageId)

  return {
    ackApplied,
    entries,
    fullyDelivered: messageEntries.length === 0 || messageEntries.every((entry) => entry.acked),
  }
}

function cleanupGuidance(
  device: BrokerInboxAuthenticatedDevice,
  reason: BrokerInboxCleanupReason,
): BrokerInboxCleanupGuidance {
  return {
    did: device.did,
    deviceId: device.deviceId,
    reason,
    note: INACTIVE_DEVICE_CLARIFICATION_NOTE,
  }
}
