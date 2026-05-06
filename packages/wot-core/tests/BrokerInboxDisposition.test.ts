import { describe, expect, it } from 'vitest'
import {
  applyBrokerInboxAck,
  computeBrokerInboxDeliveryTargets,
} from '../src/protocol'
import type {
  BrokerInboxDevice,
  BrokerInboxEntry,
} from '../src/protocol'

const ALICE_DID = 'did:key:z6Mkalice'
const BOB_DID = 'did:key:z6Mkbob'
const MESSAGE_ID = '550e8400-e29b-41d4-a716-446655440000'

function device(deviceId: string, status: BrokerInboxDevice['status'] = 'active'): BrokerInboxDevice {
  return {
    did: BOB_DID,
    deviceId,
    status,
  }
}

function entry(deviceId: string, overrides: Partial<BrokerInboxEntry> = {}): BrokerInboxEntry {
  return {
    did: BOB_DID,
    deviceId,
    messageId: MESSAGE_ID,
    acked: false,
    ...overrides,
  }
}

describe('broker inbox disposition', () => {
  it('queues one inbox entry for every explicitly active recipient device and flags inactive cleanup guidance', () => {
    const disposition = computeBrokerInboxDeliveryTargets({
      messageId: MESSAGE_ID,
      sender: { did: ALICE_DID, deviceId: 'alice-phone' },
      recipientDid: BOB_DID,
      recipientDevices: [
        device('bob-phone'),
        device('bob-laptop'),
        device('bob-revoked', 'revoked'),
        device('bob-deactivated', 'deactivated'),
      ],
    })

    expect(disposition.deliveryTargets).toEqual([
      entry('bob-phone'),
      entry('bob-laptop'),
    ])
    expect(disposition.cleanupPendingEntriesFor).toEqual([
      {
        did: BOB_DID,
        deviceId: 'bob-revoked',
        reason: 'device-revoked',
        note: '[NEEDS CLARIFICATION: wot-spec #27] inactive-device, TTL, and long-offline GC semantics are not implemented here.',
      },
      {
        did: BOB_DID,
        deviceId: 'bob-deactivated',
        reason: 'device-deactivated',
        note: '[NEEDS CLARIFICATION: wot-spec #27] inactive-device, TTL, and long-offline GC semantics are not implemented here.',
      },
    ])
    expect(disposition.fullyDelivered).toBe(false)
  })

  it('excludes the authenticated sending device from self-addressed delivery targets without queueing a sender entry', () => {
    const disposition = computeBrokerInboxDeliveryTargets({
      messageId: MESSAGE_ID,
      sender: { did: BOB_DID, deviceId: 'bob-phone' },
      recipientDid: BOB_DID,
      recipientDevices: [
        device('bob-phone'),
        device('bob-laptop'),
        device('bob-watch', 'revoked'),
      ],
    })

    expect(disposition.deliveryTargets).toEqual([entry('bob-laptop')])
    expect(disposition.excludedSenderTarget).toEqual({
      did: BOB_DID,
      deviceId: 'bob-phone',
      reason: 'self-addressed-sender-excluded',
    })
    expect(disposition.fullyDelivered).toBe(false)
  })

  it('represents no-target self-addressed delivery without requiring a stored sender inbox entry', () => {
    const disposition = computeBrokerInboxDeliveryTargets({
      messageId: MESSAGE_ID,
      sender: { did: BOB_DID, deviceId: 'bob-phone' },
      recipientDid: BOB_DID,
      recipientDevices: [device('bob-phone')],
    })

    expect(disposition.deliveryTargets).toEqual([])
    expect(disposition.excludedSenderTarget).toEqual({
      did: BOB_DID,
      deviceId: 'bob-phone',
      reason: 'self-addressed-sender-excluded',
    })
    expect(disposition.fullyDelivered).toBe(true)
  })

  it('applies ACKs only to the authenticated device entry for the matching messageId', () => {
    const pendingEntries = Object.freeze([
      Object.freeze(entry('bob-phone')),
      Object.freeze(entry('bob-laptop')),
    ])

    const phoneAck = applyBrokerInboxAck({
      authenticatedDevice: { did: BOB_DID, deviceId: 'bob-phone' },
      messageId: MESSAGE_ID,
      entries: pendingEntries,
    })

    expect(phoneAck.ackApplied).toBe(true)
    expect(phoneAck.entries).toEqual([
      entry('bob-phone', { acked: true }),
      entry('bob-laptop'),
    ])
    expect(phoneAck.fullyDelivered).toBe(false)
    expect(pendingEntries).toEqual([entry('bob-phone'), entry('bob-laptop')])

    const laptopAck = applyBrokerInboxAck({
      authenticatedDevice: { did: BOB_DID, deviceId: 'bob-laptop' },
      messageId: MESSAGE_ID,
      entries: phoneAck.entries,
    })

    expect(laptopAck.ackApplied).toBe(true)
    expect(laptopAck.entries).toEqual([
      entry('bob-phone', { acked: true }),
      entry('bob-laptop', { acked: true }),
    ])
    expect(laptopAck.fullyDelivered).toBe(true)
  })

  it('does not let a self-addressed sender ACK clear sibling device inbox entries', () => {
    const senderAck = applyBrokerInboxAck({
      authenticatedDevice: { did: BOB_DID, deviceId: 'bob-phone' },
      messageId: MESSAGE_ID,
      entries: [entry('bob-laptop')],
    })

    expect(senderAck.ackApplied).toBe(false)
    expect(senderAck.entries).toEqual([entry('bob-laptop')])
    expect(senderAck.fullyDelivered).toBe(false)
  })
})
