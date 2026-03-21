import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import WebSocket from 'ws'
import { RelayServer } from '../src/relay.js'
import type { RelayMessage, ClientMessage } from '../src/types.js'

const PORT = 9876
const RELAY_URL = `ws://localhost:${PORT}`

const ALICE_DID = 'did:key:z6MkAlice1234567890abcdefghijklmnopqrstuvwxyz'
const BOB_DID = 'did:key:z6MkBob1234567890abcdefghijklmnopqrstuvwxyzab'

function createClient(url: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url)
    ws.on('open', () => resolve(ws))
    ws.on('error', reject)
  })
}

function sendMsg(ws: WebSocket, msg: ClientMessage): void {
  ws.send(JSON.stringify(msg))
}

function waitForMessage(ws: WebSocket, timeout = 2000): Promise<RelayMessage> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Timeout waiting for message')), timeout)
    ws.once('message', (data) => {
      clearTimeout(timer)
      resolve(JSON.parse(data.toString()) as RelayMessage)
    })
  })
}

function collectMessages(ws: WebSocket, count: number, timeout = 2000): Promise<RelayMessage[]> {
  return new Promise((resolve, reject) => {
    const messages: RelayMessage[] = []
    const timer = setTimeout(() => reject(new Error(`Timeout: got ${messages.length}/${count} messages`)), timeout)
    const handler = (data: WebSocket.RawData) => {
      messages.push(JSON.parse(data.toString()) as RelayMessage)
      if (messages.length === count) {
        clearTimeout(timer)
        ws.off('message', handler)
        resolve(messages)
      }
    }
    ws.on('message', handler)
  })
}

function createTestEnvelope(fromDid: string, toDid: string) {
  return {
    v: 1,
    id: `msg-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    type: 'attestation',
    fromDid,
    toDid,
    createdAt: new Date().toISOString(),
    encoding: 'json',
    payload: JSON.stringify({ claim: 'test' }),
    signature: 'test-signature',
  }
}

describe('RelayServer', () => {
  let server: RelayServer

  beforeEach(async () => {
    server = new RelayServer({ port: PORT })
    await server.start()
  })

  afterEach(async () => {
    await server.stop()
  })

  describe('registration', () => {
    it('should confirm registration with registered message', async () => {
      const ws = await createClient(RELAY_URL)
      sendMsg(ws, { type: 'register', did: ALICE_DID })

      const msg = await waitForMessage(ws)
      expect(msg).toEqual({ type: 'registered', did: ALICE_DID, peers: 0 })

      ws.close()
    })

    it('should track connected DIDs', async () => {
      const ws = await createClient(RELAY_URL)
      sendMsg(ws, { type: 'register', did: ALICE_DID })
      await waitForMessage(ws) // registered

      expect(server.connectedDids).toContain(ALICE_DID)

      ws.close()
    })
  })

  describe('send to online recipient', () => {
    it('should deliver message and return delivered receipt', async () => {
      const alice = await createClient(RELAY_URL)
      const bob = await createClient(RELAY_URL)

      sendMsg(alice, { type: 'register', did: ALICE_DID })
      sendMsg(bob, { type: 'register', did: BOB_DID })
      await waitForMessage(alice) // registered
      await waitForMessage(bob)   // registered

      const envelope = createTestEnvelope(ALICE_DID, BOB_DID)

      // Alice sends, Bob receives
      const bobPromise = waitForMessage(bob)
      const alicePromise = waitForMessage(alice)

      sendMsg(alice, { type: 'send', envelope })

      const bobMsg = await bobPromise
      expect(bobMsg.type).toBe('message')
      if (bobMsg.type === 'message') {
        expect(bobMsg.envelope.fromDid).toBe(ALICE_DID)
        expect(bobMsg.envelope.toDid).toBe(BOB_DID)
        expect(bobMsg.envelope.id).toBe(envelope.id)
      }

      // Alice gets delivered receipt
      const aliceMsg = await alicePromise
      expect(aliceMsg.type).toBe('receipt')
      if (aliceMsg.type === 'receipt') {
        expect(aliceMsg.receipt.messageId).toBe(envelope.id)
        expect(aliceMsg.receipt.status).toBe('delivered')
      }

      alice.close()
      bob.close()
    })
  })

  describe('send to offline recipient (queuing)', () => {
    it('should queue message and return accepted receipt', async () => {
      const alice = await createClient(RELAY_URL)
      sendMsg(alice, { type: 'register', did: ALICE_DID })
      await waitForMessage(alice) // registered

      // Bob is NOT connected
      const envelope = createTestEnvelope(ALICE_DID, BOB_DID)
      sendMsg(alice, { type: 'send', envelope })

      const receipt = await waitForMessage(alice)
      expect(receipt.type).toBe('receipt')
      if (receipt.type === 'receipt') {
        expect(receipt.receipt.status).toBe('accepted') // queued, not delivered
      }

      alice.close()
    })

    it('should deliver queued messages when recipient connects', async () => {
      const alice = await createClient(RELAY_URL)
      sendMsg(alice, { type: 'register', did: ALICE_DID })
      await waitForMessage(alice) // registered

      // Send 2 messages while Bob is offline, collect both receipts
      const env1 = createTestEnvelope(ALICE_DID, BOB_DID)
      const env2 = createTestEnvelope(ALICE_DID, BOB_DID)
      const receiptsPromise = collectMessages(alice, 2)
      sendMsg(alice, { type: 'send', envelope: env1 })
      sendMsg(alice, { type: 'send', envelope: env2 })
      await receiptsPromise // both accepted

      // Now Bob connects — should receive: registered + 2 queued messages
      const bob = await createClient(RELAY_URL)
      const bobMessages = collectMessages(bob, 3) // registered + 2 messages
      sendMsg(bob, { type: 'register', did: BOB_DID })

      const msgs = await bobMessages
      expect(msgs[0].type).toBe('registered')
      expect(msgs[1].type).toBe('message')
      expect(msgs[2].type).toBe('message')

      if (msgs[1].type === 'message' && msgs[2].type === 'message') {
        expect(msgs[1].envelope.id).toBe(env1.id)
        expect(msgs[2].envelope.id).toBe(env2.id)
      }

      alice.close()
      bob.close()
    })
  })

  describe('error cases', () => {
    it('should error when sending without registration', async () => {
      const ws = await createClient(RELAY_URL)
      const envelope = createTestEnvelope(ALICE_DID, BOB_DID)
      sendMsg(ws, { type: 'send', envelope })

      const msg = await waitForMessage(ws)
      expect(msg.type).toBe('error')
      if (msg.type === 'error') {
        expect(msg.code).toBe('NOT_REGISTERED')
      }

      ws.close()
    })

    it('should error on invalid JSON', async () => {
      const ws = await createClient(RELAY_URL)
      ws.send('not valid json {{{')

      const msg = await waitForMessage(ws)
      expect(msg.type).toBe('error')
      if (msg.type === 'error') {
        expect(msg.code).toBe('INVALID_MESSAGE')
      }

      ws.close()
    })
  })

  describe('disconnect', () => {
    it('should remove DID mapping on disconnect', async () => {
      const ws = await createClient(RELAY_URL)
      sendMsg(ws, { type: 'register', did: ALICE_DID })
      await waitForMessage(ws) // registered

      expect(server.connectedDids).toContain(ALICE_DID)

      ws.close()
      // Wait for close to propagate
      await new Promise((r) => setTimeout(r, 100))

      expect(server.connectedDids).not.toContain(ALICE_DID)
    })
  })

  describe('multiple clients', () => {
    it('should handle multiple simultaneous connections', async () => {
      const alice = await createClient(RELAY_URL)
      const bob = await createClient(RELAY_URL)
      const charlie = await createClient(RELAY_URL)

      sendMsg(alice, { type: 'register', did: ALICE_DID })
      sendMsg(bob, { type: 'register', did: BOB_DID })
      sendMsg(charlie, { type: 'register', did: 'did:key:z6MkCharlie' })

      await waitForMessage(alice)
      await waitForMessage(bob)
      await waitForMessage(charlie)

      expect(server.connectedDids).toHaveLength(3)

      alice.close()
      bob.close()
      charlie.close()
    })
  })

  describe('multi-device (same DID)', () => {
    it('should deliver message to all devices of a DID', async () => {
      const alice = await createClient(RELAY_URL)
      const bobDevice1 = await createClient(RELAY_URL)
      const bobDevice2 = await createClient(RELAY_URL)

      sendMsg(alice, { type: 'register', did: ALICE_DID })
      sendMsg(bobDevice1, { type: 'register', did: BOB_DID })
      sendMsg(bobDevice2, { type: 'register', did: BOB_DID })

      await waitForMessage(alice)    // registered
      await waitForMessage(bobDevice1) // registered
      await waitForMessage(bobDevice2) // registered

      // Bob should appear once in connectedDids
      expect(server.connectedDids.filter(d => d === BOB_DID)).toHaveLength(1)

      const envelope = createTestEnvelope(ALICE_DID, BOB_DID)

      const d1Promise = waitForMessage(bobDevice1)
      const d2Promise = waitForMessage(bobDevice2)
      const receiptPromise = waitForMessage(alice)

      sendMsg(alice, { type: 'send', envelope })

      const [d1Msg, d2Msg, receipt] = await Promise.all([d1Promise, d2Promise, receiptPromise])

      // Both devices receive the message
      expect(d1Msg.type).toBe('message')
      expect(d2Msg.type).toBe('message')
      if (d1Msg.type === 'message') expect(d1Msg.envelope.id).toBe(envelope.id)
      if (d2Msg.type === 'message') expect(d2Msg.envelope.id).toBe(envelope.id)

      // Sender gets delivered receipt
      expect(receipt.type).toBe('receipt')
      if (receipt.type === 'receipt') expect(receipt.receipt.status).toBe('delivered')

      alice.close()
      bobDevice1.close()
      bobDevice2.close()
    })

    it('should keep other devices connected when one disconnects', async () => {
      const bobDevice1 = await createClient(RELAY_URL)
      const bobDevice2 = await createClient(RELAY_URL)

      sendMsg(bobDevice1, { type: 'register', did: BOB_DID })
      sendMsg(bobDevice2, { type: 'register', did: BOB_DID })

      await waitForMessage(bobDevice1)
      await waitForMessage(bobDevice2)

      // Disconnect device 1
      bobDevice1.close()
      await new Promise((r) => setTimeout(r, 100))

      // Bob should still be connected (device 2)
      expect(server.connectedDids).toContain(BOB_DID)

      // Send a message — should reach device 2
      const alice = await createClient(RELAY_URL)
      sendMsg(alice, { type: 'register', did: ALICE_DID })
      await waitForMessage(alice) // registered

      const envelope = createTestEnvelope(ALICE_DID, BOB_DID)
      const d2Promise = waitForMessage(bobDevice2)
      sendMsg(alice, { type: 'send', envelope })

      const d2Msg = await d2Promise
      expect(d2Msg.type).toBe('message')

      alice.close()
      bobDevice2.close()
    })

    it('should remove DID when all devices disconnect', async () => {
      const bobDevice1 = await createClient(RELAY_URL)
      const bobDevice2 = await createClient(RELAY_URL)

      sendMsg(bobDevice1, { type: 'register', did: BOB_DID })
      sendMsg(bobDevice2, { type: 'register', did: BOB_DID })

      await waitForMessage(bobDevice1)
      await waitForMessage(bobDevice2)

      bobDevice1.close()
      bobDevice2.close()
      await new Promise((r) => setTimeout(r, 100))

      expect(server.connectedDids).not.toContain(BOB_DID)
    })
  })

  describe('delivery acknowledgment', () => {
    it('should remove message from queue after ACK', async () => {
      const alice = await createClient(RELAY_URL)
      const bob = await createClient(RELAY_URL)

      sendMsg(alice, { type: 'register', did: ALICE_DID })
      sendMsg(bob, { type: 'register', did: BOB_DID })
      await waitForMessage(alice)
      await waitForMessage(bob)

      const envelope = createTestEnvelope(ALICE_DID, BOB_DID)

      const bobPromise = waitForMessage(bob)
      const alicePromise = waitForMessage(alice)
      sendMsg(alice, { type: 'send', envelope })

      const bobMsg = await bobPromise
      expect(bobMsg.type).toBe('message')
      await alicePromise // delivered receipt

      // Bob sends ACK
      sendMsg(bob, { type: 'ack', messageId: envelope.id })
      await new Promise((r) => setTimeout(r, 50))

      // Bob disconnects and reconnects — should NOT get the message again
      bob.close()
      await new Promise((r) => setTimeout(r, 50))

      const bob2 = await createClient(RELAY_URL)
      // Should only get 'registered', no redelivered messages
      sendMsg(bob2, { type: 'register', did: BOB_DID })
      const regMsg = await waitForMessage(bob2)
      expect(regMsg.type).toBe('registered')

      // Wait briefly to ensure no more messages arrive
      const noMore = await Promise.race([
        waitForMessage(bob2, 300).then(() => 'got-message').catch(() => 'timeout'),
        new Promise((r) => setTimeout(r, 200)).then(() => 'timeout'),
      ])
      expect(noMore).toBe('timeout')

      alice.close()
      bob2.close()
    })

    it('should redeliver unACKed messages on reconnect', async () => {
      const alice = await createClient(RELAY_URL)
      const bob = await createClient(RELAY_URL)

      sendMsg(alice, { type: 'register', did: ALICE_DID })
      sendMsg(bob, { type: 'register', did: BOB_DID })
      await waitForMessage(alice)
      await waitForMessage(bob)

      const envelope = createTestEnvelope(ALICE_DID, BOB_DID)

      const bobPromise = waitForMessage(bob)
      sendMsg(alice, { type: 'send', envelope })
      await bobPromise // Bob receives but does NOT ACK

      // Bob disconnects without ACKing
      bob.close()
      await new Promise((r) => setTimeout(r, 50))

      // Bob reconnects — should get redelivered message
      const bob2 = await createClient(RELAY_URL)
      const msgs = collectMessages(bob2, 2) // registered + redelivered message
      sendMsg(bob2, { type: 'register', did: BOB_DID })

      const received = await msgs
      expect(received[0].type).toBe('registered')
      expect(received[1].type).toBe('message')
      if (received[1].type === 'message') {
        expect(received[1].envelope.id).toBe(envelope.id)
      }

      alice.close()
      bob2.close()
    })

    it('should persist online-delivered messages until ACK', async () => {
      const alice = await createClient(RELAY_URL)
      const bob = await createClient(RELAY_URL)

      sendMsg(alice, { type: 'register', did: ALICE_DID })
      sendMsg(bob, { type: 'register', did: BOB_DID })
      await waitForMessage(alice)
      await waitForMessage(bob)

      // Send message while Bob is online
      const envelope = createTestEnvelope(ALICE_DID, BOB_DID)
      const bobPromise = waitForMessage(bob)
      sendMsg(alice, { type: 'send', envelope })

      const bobMsg = await bobPromise
      expect(bobMsg.type).toBe('message')

      // Message is in DB (delivered but unACKed)
      // Verify by disconnecting Bob and checking reconnect
      bob.close()
      await new Promise((r) => setTimeout(r, 50))

      const bob2 = await createClient(RELAY_URL)
      const msgs = collectMessages(bob2, 2) // registered + redelivered
      sendMsg(bob2, { type: 'register', did: BOB_DID })

      const received = await msgs
      expect(received[0].type).toBe('registered')
      expect(received[1].type).toBe('message')
      if (received[1].type === 'message') {
        expect(received[1].envelope.id).toBe(envelope.id)
      }

      // Now ACK and verify it's gone
      sendMsg(bob2, { type: 'ack', messageId: envelope.id })
      await new Promise((r) => setTimeout(r, 50))

      bob2.close()
      await new Promise((r) => setTimeout(r, 50))

      const bob3 = await createClient(RELAY_URL)
      sendMsg(bob3, { type: 'register', did: BOB_DID })
      const regOnly = await waitForMessage(bob3)
      expect(regOnly.type).toBe('registered')

      const noMore = await Promise.race([
        waitForMessage(bob3, 300).then(() => 'got-message').catch(() => 'timeout'),
        new Promise((r) => setTimeout(r, 200)).then(() => 'timeout'),
      ])
      expect(noMore).toBe('timeout')

      alice.close()
      bob3.close()
    })

    it('should ACK messages individually', async () => {
      const alice = await createClient(RELAY_URL)
      sendMsg(alice, { type: 'register', did: ALICE_DID })
      await waitForMessage(alice)

      // Send 2 messages while Bob is offline
      const env1 = createTestEnvelope(ALICE_DID, BOB_DID)
      const env2 = createTestEnvelope(ALICE_DID, BOB_DID)
      const receipts = collectMessages(alice, 2)
      sendMsg(alice, { type: 'send', envelope: env1 })
      sendMsg(alice, { type: 'send', envelope: env2 })
      await receipts

      // Bob connects — receives both
      const bob = await createClient(RELAY_URL)
      const msgs = collectMessages(bob, 3) // registered + 2 messages
      sendMsg(bob, { type: 'register', did: BOB_DID })
      await msgs

      // ACK only env1
      sendMsg(bob, { type: 'ack', messageId: env1.id })
      await new Promise((r) => setTimeout(r, 50))

      // Bob reconnects — should only get env2 (env1 was ACKed)
      bob.close()
      await new Promise((r) => setTimeout(r, 50))

      const bob2 = await createClient(RELAY_URL)
      const msgs2 = collectMessages(bob2, 2) // registered + env2
      sendMsg(bob2, { type: 'register', did: BOB_DID })

      const received = await msgs2
      expect(received[0].type).toBe('registered')
      expect(received[1].type).toBe('message')
      if (received[1].type === 'message') {
        expect(received[1].envelope.id).toBe(env2.id)
      }

      alice.close()
      bob2.close()
    })

    it('should ignore ACK from unregistered client', async () => {
      const ws = await createClient(RELAY_URL)
      // Send ACK without registering — should not crash
      sendMsg(ws, { type: 'ack', messageId: 'nonexistent' })
      await new Promise((r) => setTimeout(r, 50))

      // Server should still be working
      const alice = await createClient(RELAY_URL)
      sendMsg(alice, { type: 'register', did: ALICE_DID })
      const msg = await waitForMessage(alice)
      expect(msg.type).toBe('registered')

      ws.close()
      alice.close()
    })

    it('should accept ACK from any device of the same DID', async () => {
      const alice = await createClient(RELAY_URL)
      const bobDevice1 = await createClient(RELAY_URL)
      const bobDevice2 = await createClient(RELAY_URL)

      sendMsg(alice, { type: 'register', did: ALICE_DID })
      sendMsg(bobDevice1, { type: 'register', did: BOB_DID })
      sendMsg(bobDevice2, { type: 'register', did: BOB_DID })
      await waitForMessage(alice)
      await waitForMessage(bobDevice1)
      await waitForMessage(bobDevice2)

      const envelope = createTestEnvelope(ALICE_DID, BOB_DID)
      const d1Promise = waitForMessage(bobDevice1)
      const d2Promise = waitForMessage(bobDevice2)
      sendMsg(alice, { type: 'send', envelope })
      await d1Promise
      await d2Promise
      await waitForMessage(alice) // delivered receipt

      // Only device2 ACKs — should be enough
      sendMsg(bobDevice2, { type: 'ack', messageId: envelope.id })
      await new Promise((r) => setTimeout(r, 50))

      // Both devices disconnect, reconnect — no redelivery
      bobDevice1.close()
      bobDevice2.close()
      await new Promise((r) => setTimeout(r, 50))

      const bob3 = await createClient(RELAY_URL)
      sendMsg(bob3, { type: 'register', did: BOB_DID })
      const regMsg = await waitForMessage(bob3)
      expect(regMsg.type).toBe('registered')

      const noMore = await Promise.race([
        waitForMessage(bob3, 300).then(() => 'got-message').catch(() => 'timeout'),
        new Promise((r) => setTimeout(r, 200)).then(() => 'timeout'),
      ])
      expect(noMore).toBe('timeout')

      alice.close()
      bob3.close()
    })
  })
})
