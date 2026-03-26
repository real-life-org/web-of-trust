import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as Y from 'yjs'
import { YjsPersonalSyncAdapter } from '../src/YjsPersonalSyncAdapter'
import type { MessagingAdapter, MessageEnvelope, DeliveryReceipt, MessagingState } from '@web.of.trust/core'

/**
 * Minimal messaging pair that simulates a relay:
 * What device1 sends is delivered to device2 and vice versa.
 * Both devices have the same DID (multi-device scenario).
 */
function createMessagingPair(did: string) {
  const callbacks1 = new Set<(e: MessageEnvelope) => void | Promise<void>>()
  const callbacks2 = new Set<(e: MessageEnvelope) => void | Promise<void>>()

  function makeAdapter(myCallbacks: Set<(e: MessageEnvelope) => void | Promise<void>>, otherCallbacks: Set<(e: MessageEnvelope) => void | Promise<void>>): MessagingAdapter {
    return {
      connect: async () => {},
      disconnect: async () => {},
      getState: () => 'connected' as MessagingState,
      send: async (envelope: MessageEnvelope) => {
        // Relay: deliver to the other device (async, like a real relay)
        setTimeout(() => {
          for (const cb of otherCallbacks) {
            cb(envelope)
          }
        }, 5)
        return { messageId: envelope.id, status: 'accepted', timestamp: new Date().toISOString() } as DeliveryReceipt
      },
      onMessage: (cb: (e: MessageEnvelope) => void | Promise<void>) => {
        myCallbacks.add(cb)
        return () => { myCallbacks.delete(cb) }
      },
      onReceipt: () => () => {},
      onStateChange: () => () => {},
      registerTransport: async () => {},
      resolveTransport: async () => null,
    }
  }

  return {
    messaging1: makeAdapter(callbacks1, callbacks2),
    messaging2: makeAdapter(callbacks2, callbacks1),
  }
}

describe('YjsPersonalSyncAdapter', () => {
  const myDid = 'did:key:z6MkDevice'
  let personalKey: Uint8Array

  let doc1: Y.Doc
  let doc2: Y.Doc
  let messaging1: MessagingAdapter
  let messaging2: MessagingAdapter
  let sync1: YjsPersonalSyncAdapter
  let sync2: YjsPersonalSyncAdapter

  beforeEach(() => {
    personalKey = crypto.getRandomValues(new Uint8Array(32))

    doc1 = new Y.Doc()
    doc2 = new Y.Doc()

    const pair = createMessagingPair(myDid)
    messaging1 = pair.messaging1
    messaging2 = pair.messaging2

    sync1 = new YjsPersonalSyncAdapter(doc1, messaging1, personalKey, myDid)
    sync2 = new YjsPersonalSyncAdapter(doc2, messaging2, personalKey, myDid)
  })

  afterEach(() => {
    sync1.destroy()
    sync2.destroy()
    doc1.destroy()
    doc2.destroy()
  })

  it('should sync a change from device 1 to device 2', async () => {
    sync1.start()
    sync2.start()

    doc1.getMap('profile').set('name', 'Anton')

    await new Promise(r => setTimeout(r, 200))
    expect(doc2.getMap('profile').get('name')).toBe('Anton')
  })

  it('should sync bidirectionally', async () => {
    sync1.start()
    sync2.start()

    doc1.getMap('contacts').set('alice', 'Alice')
    await new Promise(r => setTimeout(r, 200))
    expect(doc2.getMap('contacts').get('alice')).toBe('Alice')

    doc2.getMap('contacts').set('bob', 'Bob')
    await new Promise(r => setTimeout(r, 200))
    expect(doc1.getMap('contacts').get('bob')).toBe('Bob')
  })

  it('should encrypt sync messages', async () => {
    const sentPayloads: string[] = []
    const origSend = messaging1.send
    messaging1.send = async (envelope: MessageEnvelope) => {
      sentPayloads.push(envelope.payload)
      return origSend(envelope)
    }

    sync1.start()
    sync2.start()
    doc1.getMap('profile').set('secret', 'my-password-123')
    await new Promise(r => setTimeout(r, 200))

    expect(sentPayloads.length).toBeGreaterThan(0)
    for (const payload of sentPayloads) {
      expect(payload).not.toContain('my-password-123')
    }
  })

  it('should not sync before start()', async () => {
    doc1.getMap('profile').set('name', 'Anton')
    await new Promise(r => setTimeout(r, 200))
    expect(doc2.getMap('profile').get('name')).toBeUndefined()
  })

  it('should stop syncing after destroy()', async () => {
    sync1.start()
    sync2.start()

    doc1.getMap('profile').set('name', 'Anton')
    await new Promise(r => setTimeout(r, 200))
    expect(doc2.getMap('profile').get('name')).toBe('Anton')

    sync1.destroy()

    doc1.getMap('profile').set('name', 'Changed')
    await new Promise(r => setTimeout(r, 200))
    expect(doc2.getMap('profile').get('name')).toBe('Anton')
  })

  it('should use personal-sync message type', async () => {
    let capturedType: string | undefined
    const origSend = messaging1.send
    messaging1.send = async (envelope: MessageEnvelope) => {
      capturedType = envelope.type as string
      return origSend(envelope)
    }

    sync1.start()
    doc1.getMap('profile').set('name', 'Test')
    await new Promise(r => setTimeout(r, 200))

    expect(capturedType).toBe('personal-sync')
  })

  it('should handle concurrent changes on both devices', async () => {
    sync1.start()
    sync2.start()

    // Both devices change different fields simultaneously
    doc1.getMap('profile').set('name', 'From Device 1')
    doc2.getMap('profile').set('bio', 'From Device 2')
    await new Promise(r => setTimeout(r, 200))

    // Both should have both changes (CRDT merge)
    expect(doc1.getMap('profile').get('name')).toBe('From Device 1')
    expect(doc1.getMap('profile').get('bio')).toBe('From Device 2')
    expect(doc2.getMap('profile').get('name')).toBe('From Device 1')
    expect(doc2.getMap('profile').get('bio')).toBe('From Device 2')
  })
})
