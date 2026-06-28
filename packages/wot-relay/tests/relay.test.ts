import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { randomUUID } from 'crypto'
import WebSocket from 'ws'
import { RelayServer } from '../src/relay.js'
import type { RelayMessage, ClientMessage } from '../src/types.js'
import { protocol } from '@web_of_trust/core'

const {
  encodeBase58,
  encodeBase64Url,
  buildBrokerAuthTranscript,
  createBrokerAuthTranscriptSigningBytes,
} = protocol

const PORT = 9876
const RELAY_URL = `ws://localhost:${PORT}`

// --- Ed25519 key generation + Sync 003 transcript signing ---

interface TestIdentity {
  did: string
  signTranscript: (input: { did: string; deviceId: string; nonce: string }) => Promise<string>
}

async function generateIdentity(): Promise<TestIdentity> {
  const keyPair = await crypto.subtle.generateKey('Ed25519', true, ['sign', 'verify'])
  const publicKeyBytes = new Uint8Array(await crypto.subtle.exportKey('raw', keyPair.publicKey))
  const prefixed = new Uint8Array(2 + publicKeyBytes.length)
  prefixed[0] = 0xed
  prefixed[1] = 0x01
  prefixed.set(publicKeyBytes, 2)
  const did = 'did:key:z' + encodeBase58(prefixed)

  const signTranscript = async (input: { did: string; deviceId: string; nonce: string }) => {
    const transcript = buildBrokerAuthTranscript(input)
    const signingBytes = createBrokerAuthTranscriptSigningBytes(transcript)
    const sig = await crypto.subtle.sign('Ed25519', keyPair.privateKey, signingBytes)
    return encodeBase64Url(new Uint8Array(sig))
  }

  return { did, signTranscript }
}

// --- WebSocket helpers ---

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

interface RegisteredClient {
  deviceId: string
  registered: RelayMessage
}

async function registerClient(
  ws: WebSocket,
  identity: TestIdentity,
  deviceId: string = randomUUID(),
): Promise<RegisteredClient> {
  sendMsg(ws, { type: 'register', did: identity.did, deviceId })

  const challenge = await waitForMessage(ws)
  if (challenge.type !== 'challenge') {
    throw new Error(`Expected challenge, got ${challenge.type}`)
  }

  const signature = await identity.signTranscript({
    did: identity.did,
    deviceId,
    nonce: challenge.nonce,
  })
  sendMsg(ws, {
    type: 'challenge-response',
    did: identity.did,
    deviceId,
    nonce: challenge.nonce,
    signature,
  })

  const registered = await waitForMessage(ws)
  return { deviceId, registered }
}

// Routing/queue/multi-device vehicle: a whitelisted DIDComm Inbox envelope
// (inbox/1.0). The deprecated old-world content/v:1 envelope is rejected by the
// relay-whitelist (Sync 003 VE-R2), so the generic relay mechanics are exercised
// over a relay-eligible transport type. The relay routes by to[0] and is opaque
// to the ECIES body — these tests assert routing/queue/receipt, not crypto.
function createTestEnvelope(fromDid: string, toDid: string) {
  return {
    id: randomUUID(),
    typ: 'application/didcomm-plain+json',
    type: 'https://web-of-trust.de/protocols/inbox/1.0',
    from: fromDid,
    to: [toDid],
    created_time: Math.floor(Date.now() / 1000),
    body: { epk: 'ZXBr', nonce: 'bm9uY2U', ciphertext: 'Y2lwaGVydGV4dA' },
  }
}

// ack/1.0 (Sync 003) — the reception host's per-device receipt that clears an
// inbox queue slot. `from` is the authenticated recipient DID; thid + body
// reference the original message id (a canonical lowercase UUID v4).
function ackEnvelope(fromDid: string, messageId: string) {
  return {
    id: randomUUID(),
    typ: 'application/didcomm-plain+json',
    type: 'https://web-of-trust.de/protocols/ack/1.0',
    from: fromDid,
    created_time: Math.floor(Date.now() / 1000),
    thid: messageId,
    body: { messageId },
  }
}

// --- Tests ---

describe('RelayServer', () => {
  let server: RelayServer
  let alice: TestIdentity
  let bob: TestIdentity

  beforeEach(async () => {
    server = new RelayServer({ port: PORT })
    await server.start()
    alice = await generateIdentity()
    bob = await generateIdentity()
  })

  afterEach(async () => {
    await server.stop()
  })

  describe('Sync 003 challenge-response auth', () => {
    it('issues canonical unpadded Base64URL 32-byte nonce on register', async () => {
      const ws = await createClient(RELAY_URL)
      const deviceId = randomUUID()
      sendMsg(ws, { type: 'register', did: alice.did, deviceId })

      const msg = await waitForMessage(ws)
      expect(msg.type).toBe('challenge')
      if (msg.type === 'challenge') {
        expect(msg.nonce).toMatch(/^[A-Za-z0-9_-]{43}$/)
      }

      ws.close()
    })

    it('confirms registration after valid Sync 003 challenge-response', async () => {
      const ws = await createClient(RELAY_URL)
      const { registered, deviceId } = await registerClient(ws, alice)

      expect(registered.type).toBe('registered')
      if (registered.type === 'registered') {
        expect(registered.did).toBe(alice.did)
        expect(registered.deviceId).toBe(deviceId)
        expect(typeof registered.isNewDevice).toBe('boolean')
      }
      expect(server.connectedDids).toContain(alice.did)

      ws.close()
    })

    it('rejects a transcript signed by the wrong key as AUTH_INVALID', async () => {
      const ws = await createClient(RELAY_URL)
      const deviceId = randomUUID()
      sendMsg(ws, { type: 'register', did: alice.did, deviceId })

      const challenge = await waitForMessage(ws)
      if (challenge.type !== 'challenge') throw new Error('Expected challenge')

      const wrongSig = await bob.signTranscript({
        did: alice.did,
        deviceId,
        nonce: challenge.nonce,
      })
      sendMsg(ws, {
        type: 'challenge-response',
        did: alice.did,
        deviceId,
        nonce: challenge.nonce,
        signature: wrongSig,
      })

      const msg = await waitForMessage(ws)
      expect(msg.type).toBe('error')
      if (msg.type === 'error') {
        expect(msg.code).toBe('AUTH_INVALID')
      }

      ws.close()
    })

    it('rejects challenge-response without pending challenge as AUTH_INVALID', async () => {
      const ws = await createClient(RELAY_URL)
      sendMsg(ws, {
        type: 'challenge-response',
        did: alice.did,
        deviceId: randomUUID(),
        nonce: 'A'.repeat(43),
        signature: encodeBase64Url(new Uint8Array(64)),
      })

      const msg = await waitForMessage(ws)
      expect(msg.type).toBe('error')
      if (msg.type === 'error') {
        expect(msg.code).toBe('AUTH_INVALID')
      }

      ws.close()
    })

    it('rejects malformed did:key on register with MALFORMED_MESSAGE', async () => {
      const ws = await createClient(RELAY_URL)
      sendMsg(ws, { type: 'register', did: 'not-a-did', deviceId: randomUUID() })

      const msg = await waitForMessage(ws)
      expect(msg.type).toBe('error')
      if (msg.type === 'error') {
        expect(msg.code).toBe('MALFORMED_MESSAGE')
      }

      ws.close()
    })

    it('rejects register without deviceId with MALFORMED_MESSAGE', async () => {
      const ws = await createClient(RELAY_URL)
      ws.send(JSON.stringify({ type: 'register', did: alice.did }))

      const msg = await waitForMessage(ws)
      expect(msg.type).toBe('error')
      if (msg.type === 'error') {
        expect(msg.code).toBe('MALFORMED_MESSAGE')
      }

      ws.close()
    })
  })

  describe('registration', () => {
    it('should track connected DIDs', async () => {
      const ws = await createClient(RELAY_URL)
      await registerClient(ws, alice)

      expect(server.connectedDids).toContain(alice.did)

      ws.close()
    })
  })

  describe('send to online recipient', () => {
    it('should deliver message and return delivered receipt', async () => {
      const aliceWs = await createClient(RELAY_URL)
      const bobWs = await createClient(RELAY_URL)

      await registerClient(aliceWs, alice)
      await registerClient(bobWs, bob)

      const envelope = createTestEnvelope(alice.did, bob.did)

      const bobPromise = waitForMessage(bobWs)
      const alicePromise = waitForMessage(aliceWs)

      sendMsg(aliceWs, { type: 'send', envelope })

      const bobMsg = await bobPromise
      expect(bobMsg.type).toBe('message')
      if (bobMsg.type === 'message') {
        expect((bobMsg.envelope as Record<string, unknown>).from).toBe(alice.did)
        expect((bobMsg.envelope as Record<string, unknown>).to).toEqual([bob.did])
        expect(bobMsg.envelope.id).toBe(envelope.id)
      }

      const aliceMsg = await alicePromise
      expect(aliceMsg.type).toBe('receipt')
      if (aliceMsg.type === 'receipt') {
        expect(aliceMsg.receipt.messageId).toBe(envelope.id)
        expect(aliceMsg.receipt.status).toBe('delivered')
      }

      aliceWs.close()
      bobWs.close()
    })
  })

  describe('send to offline recipient (queuing)', () => {
    it('should queue message and return accepted receipt', async () => {
      const aliceWs = await createClient(RELAY_URL)
      await registerClient(aliceWs, alice)

      const envelope = createTestEnvelope(alice.did, bob.did)
      sendMsg(aliceWs, { type: 'send', envelope })

      const receipt = await waitForMessage(aliceWs)
      expect(receipt.type).toBe('receipt')
      if (receipt.type === 'receipt') {
        expect(receipt.receipt.status).toBe('accepted')
      }

      aliceWs.close()
    })

    it('should deliver queued messages when recipient connects', async () => {
      const aliceWs = await createClient(RELAY_URL)
      await registerClient(aliceWs, alice)

      const env1 = createTestEnvelope(alice.did, bob.did)
      const env2 = createTestEnvelope(alice.did, bob.did)
      const receiptsPromise = collectMessages(aliceWs, 2)
      sendMsg(aliceWs, { type: 'send', envelope: env1 })
      sendMsg(aliceWs, { type: 'send', envelope: env2 })
      await receiptsPromise

      const bobWs = await createClient(RELAY_URL)
      const deviceId = randomUUID()
      sendMsg(bobWs, { type: 'register', did: bob.did, deviceId })

      const challenge = await waitForMessage(bobWs)
      expect(challenge.type).toBe('challenge')
      if (challenge.type !== 'challenge') throw new Error('Expected challenge')

      const sig = await bob.signTranscript({ did: bob.did, deviceId, nonce: challenge.nonce })
      const bobMessages = collectMessages(bobWs, 3)
      sendMsg(bobWs, {
        type: 'challenge-response',
        did: bob.did,
        deviceId,
        nonce: challenge.nonce,
        signature: sig,
      })

      const msgs = await bobMessages
      expect(msgs[0].type).toBe('registered')
      expect(msgs[1].type).toBe('message')
      expect(msgs[2].type).toBe('message')

      if (msgs[1].type === 'message' && msgs[2].type === 'message') {
        expect(msgs[1].envelope.id).toBe(env1.id)
        expect(msgs[2].envelope.id).toBe(env2.id)
      }

      aliceWs.close()
      bobWs.close()
    })
  })

  describe('error cases', () => {
    it('should error when sending without registration', async () => {
      const ws = await createClient(RELAY_URL)
      const envelope = createTestEnvelope(alice.did, bob.did)
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
        expect(msg.code).toBe('MALFORMED_MESSAGE')
      }

      ws.close()
    })
  })

  describe('disconnect', () => {
    it('should remove DID mapping on disconnect', async () => {
      const ws = await createClient(RELAY_URL)
      await registerClient(ws, alice)

      expect(server.connectedDids).toContain(alice.did)

      ws.close()
      await new Promise((r) => setTimeout(r, 100))

      expect(server.connectedDids).not.toContain(alice.did)
    })
  })

  describe('multiple clients', () => {
    it('should handle multiple simultaneous connections', async () => {
      const charlie = await generateIdentity()
      const aliceWs = await createClient(RELAY_URL)
      const bobWs = await createClient(RELAY_URL)
      const charlieWs = await createClient(RELAY_URL)

      await registerClient(aliceWs, alice)
      await registerClient(bobWs, bob)
      await registerClient(charlieWs, charlie)

      expect(server.connectedDids).toHaveLength(3)

      aliceWs.close()
      bobWs.close()
      charlieWs.close()
    })
  })

  describe('multi-device (same DID)', () => {
    it('should deliver message to all devices of a DID', async () => {
      const aliceWs = await createClient(RELAY_URL)
      const bobDevice1 = await createClient(RELAY_URL)
      const bobDevice2 = await createClient(RELAY_URL)

      await registerClient(aliceWs, alice)
      await registerClient(bobDevice1, bob)
      await registerClient(bobDevice2, bob)

      expect(server.connectedDids.filter(d => d === bob.did)).toHaveLength(1)

      const envelope = createTestEnvelope(alice.did, bob.did)

      const d1Promise = waitForMessage(bobDevice1)
      const d2Promise = waitForMessage(bobDevice2)
      const receiptPromise = waitForMessage(aliceWs)

      sendMsg(aliceWs, { type: 'send', envelope })

      const [d1Msg, d2Msg, receipt] = await Promise.all([d1Promise, d2Promise, receiptPromise])

      expect(d1Msg.type).toBe('message')
      expect(d2Msg.type).toBe('message')
      if (d1Msg.type === 'message') expect(d1Msg.envelope.id).toBe(envelope.id)
      if (d2Msg.type === 'message') expect(d2Msg.envelope.id).toBe(envelope.id)

      expect(receipt.type).toBe('receipt')
      if (receipt.type === 'receipt') expect(receipt.receipt.status).toBe('delivered')

      aliceWs.close()
      bobDevice1.close()
      bobDevice2.close()
    })

    it('should deliver self-addressed messages to sibling devices, not the sender socket', async () => {
      const bobDevice1 = await createClient(RELAY_URL)
      const bobDevice2 = await createClient(RELAY_URL)

      await registerClient(bobDevice1, bob)
      await registerClient(bobDevice2, bob)

      const envelope = createTestEnvelope(bob.did, bob.did)

      const d1Promise = waitForMessage(bobDevice1)
      const d2Promise = waitForMessage(bobDevice2)

      sendMsg(bobDevice1, { type: 'send', envelope })

      const [d1Msg, d2Msg] = await Promise.all([d1Promise, d2Promise])

      expect(d1Msg.type).toBe('receipt')
      if (d1Msg.type === 'receipt') {
        expect(d1Msg.receipt.messageId).toBe(envelope.id)
        expect(d1Msg.receipt.status).toBe('delivered')
      }
      expect(d2Msg.type).toBe('message')
      if (d2Msg.type === 'message') expect(d2Msg.envelope.id).toBe(envelope.id)

      bobDevice1.close()
      bobDevice2.close()
    })

    it('should queue self-addressed messages when only the sender device is online', async () => {
      const bobDevice1 = await createClient(RELAY_URL)

      await registerClient(bobDevice1, bob)

      const envelope = createTestEnvelope(bob.did, bob.did)
      sendMsg(bobDevice1, { type: 'send', envelope })

      const receipt = await waitForMessage(bobDevice1)
      expect(receipt.type).toBe('receipt')
      if (receipt.type === 'receipt') {
        expect(receipt.receipt.messageId).toBe(envelope.id)
        expect(receipt.receipt.status).toBe('accepted')
      }

      const bobDevice2 = await createClient(RELAY_URL)
      const deviceId = randomUUID()
      sendMsg(bobDevice2, { type: 'register', did: bob.did, deviceId })

      const challenge = await waitForMessage(bobDevice2)
      if (challenge.type !== 'challenge') throw new Error('Expected challenge')

      const sig = await bob.signTranscript({ did: bob.did, deviceId, nonce: challenge.nonce })
      const msgs = collectMessages(bobDevice2, 2)
      sendMsg(bobDevice2, {
        type: 'challenge-response',
        did: bob.did,
        deviceId,
        nonce: challenge.nonce,
        signature: sig,
      })

      const received = await msgs
      expect(received[0].type).toBe('registered')
      expect(received[1].type).toBe('message')
      if (received[1].type === 'message') expect(received[1].envelope.id).toBe(envelope.id)

      bobDevice1.close()
      bobDevice2.close()
    })

    it('should keep other devices connected when one disconnects', async () => {
      const bobDevice1 = await createClient(RELAY_URL)
      const bobDevice2 = await createClient(RELAY_URL)

      await registerClient(bobDevice1, bob)
      await registerClient(bobDevice2, bob)

      bobDevice1.close()
      await new Promise((r) => setTimeout(r, 100))

      expect(server.connectedDids).toContain(bob.did)

      const aliceWs = await createClient(RELAY_URL)
      await registerClient(aliceWs, alice)

      const envelope = createTestEnvelope(alice.did, bob.did)
      const d2Promise = waitForMessage(bobDevice2)
      sendMsg(aliceWs, { type: 'send', envelope })

      const d2Msg = await d2Promise
      expect(d2Msg.type).toBe('message')

      aliceWs.close()
      bobDevice2.close()
    })

    it('should remove DID when all devices disconnect', async () => {
      const bobDevice1 = await createClient(RELAY_URL)
      const bobDevice2 = await createClient(RELAY_URL)

      await registerClient(bobDevice1, bob)
      await registerClient(bobDevice2, bob)

      bobDevice1.close()
      bobDevice2.close()
      await new Promise((r) => setTimeout(r, 100))

      expect(server.connectedDids).not.toContain(bob.did)
    })
  })

  describe('delivery acknowledgment', () => {
    it('should remove message from queue after ACK', async () => {
      const aliceWs = await createClient(RELAY_URL)
      const bobWs = await createClient(RELAY_URL)

      await registerClient(aliceWs, alice)
      await registerClient(bobWs, bob)

      const envelope = createTestEnvelope(alice.did, bob.did)

      const bobPromise = waitForMessage(bobWs)
      const alicePromise = waitForMessage(aliceWs)
      sendMsg(aliceWs, { type: 'send', envelope })

      await bobPromise
      await alicePromise

      // The inbox channel is cleared by the recipient's ack/1.0 (Sync 003), not the
      // deprecated control-frame ack — so Bob (the reception host) sends ack/1.0.
      sendMsg(bobWs, { type: 'send', envelope: ackEnvelope(bob.did, envelope.id) })
      await new Promise((r) => setTimeout(r, 50))

      bobWs.close()
      await new Promise((r) => setTimeout(r, 50))

      const bob2 = await createClient(RELAY_URL)
      const reg = await registerClient(bob2, bob)
      expect(reg.registered.type).toBe('registered')

      const noMore = await Promise.race([
        waitForMessage(bob2, 300).then(() => 'got-message').catch(() => 'timeout'),
        new Promise((r) => setTimeout(r, 200)).then(() => 'timeout'),
      ])
      expect(noMore).toBe('timeout')

      aliceWs.close()
      bob2.close()
    })

    it('should redeliver unACKed messages on reconnect', async () => {
      const aliceWs = await createClient(RELAY_URL)
      const bobWs = await createClient(RELAY_URL)

      await registerClient(aliceWs, alice)
      await registerClient(bobWs, bob)

      const envelope = createTestEnvelope(alice.did, bob.did)

      const bobPromise = waitForMessage(bobWs)
      sendMsg(aliceWs, { type: 'send', envelope })
      await bobPromise

      bobWs.close()
      await new Promise((r) => setTimeout(r, 50))

      const bob2 = await createClient(RELAY_URL)
      const deviceId = randomUUID()
      sendMsg(bob2, { type: 'register', did: bob.did, deviceId })

      const challenge = await waitForMessage(bob2)
      if (challenge.type !== 'challenge') throw new Error('Expected challenge')

      const sig = await bob.signTranscript({ did: bob.did, deviceId, nonce: challenge.nonce })
      const msgs = collectMessages(bob2, 2)
      sendMsg(bob2, {
        type: 'challenge-response',
        did: bob.did,
        deviceId,
        nonce: challenge.nonce,
        signature: sig,
      })

      const received = await msgs
      expect(received[0].type).toBe('registered')
      expect(received[1].type).toBe('message')
      if (received[1].type === 'message') {
        expect(received[1].envelope.id).toBe(envelope.id)
      }

      aliceWs.close()
      bob2.close()
    })

    it('Device A ack does NOT delete Device B\'s slot — a fresh device still receives it (the bug; R1+R3+Z.206)', async () => {
      const aliceWs = await createClient(RELAY_URL)
      const bobD1 = await createClient(RELAY_URL)
      const bobD2 = await createClient(RELAY_URL)

      await registerClient(aliceWs, alice)
      await registerClient(bobD1, bob)
      await registerClient(bobD2, bob)

      const envelope = createTestEnvelope(alice.did, bob.did)
      const d1Promise = waitForMessage(bobD1)
      const d2Promise = waitForMessage(bobD2)
      const receiptPromise = waitForMessage(aliceWs)
      sendMsg(aliceWs, { type: 'send', envelope })
      const [d1Msg, d2Msg] = await Promise.all([d1Promise, d2Promise, receiptPromise])
      expect(d1Msg.type).toBe('message')
      expect(d2Msg.type).toBe('message')

      // Device 1 acks (ack/1.0). Under the OLD per-DID model this DELETE'd the slot
      // for the whole DID, so Device 2 (and any sibling that missed the live send)
      // would never get it. Per-device: D1's ack clears only D1's entry.
      sendMsg(bobD1, { type: 'send', envelope: ackEnvelope(bob.did, envelope.id) })
      await new Promise((r) => setTimeout(r, 50))

      // Both devices disconnect (NOT revoked → still active); a FRESH bob device
      // connects and MUST still receive it (D2 never acked → not fully delivered).
      bobD1.close()
      bobD2.close()
      await new Promise((r) => setTimeout(r, 50))

      const bobD3 = await createClient(RELAY_URL)
      const deviceId = randomUUID()
      sendMsg(bobD3, { type: 'register', did: bob.did, deviceId })
      const challenge = await waitForMessage(bobD3)
      if (challenge.type !== 'challenge') throw new Error('Expected challenge')
      const sig = await bob.signTranscript({ did: bob.did, deviceId, nonce: challenge.nonce })
      const msgs = collectMessages(bobD3, 2)
      sendMsg(bobD3, {
        type: 'challenge-response',
        did: bob.did,
        deviceId,
        nonce: challenge.nonce,
        signature: sig,
      })
      const received = await msgs
      expect(received[0].type).toBe('registered')
      expect(received[1].type).toBe('message')
      if (received[1].type === 'message') expect(received[1].envelope.id).toBe(envelope.id)

      aliceWs.close()
      bobD3.close()
    })

    it('should ignore ACK from unregistered client', async () => {
      const ws = await createClient(RELAY_URL)
      sendMsg(ws, { type: 'ack', messageId: 'nonexistent' })
      await new Promise((r) => setTimeout(r, 50))

      const aliceWs = await createClient(RELAY_URL)
      const reg = await registerClient(aliceWs, alice)
      expect(reg.registered.type).toBe('registered')

      ws.close()
      aliceWs.close()
    })
  })
})
