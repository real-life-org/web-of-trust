import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import WebSocket from 'ws'
import { RelayServer } from '../src/relay.js'
import type { RelayMessage, ClientMessage } from '../src/types.js'

const PORT = 9876
const RELAY_URL = `ws://localhost:${PORT}`

// --- Ed25519 key generation + signing for challenge-response ---

async function generateIdentity(): Promise<{ did: string; sign: (data: string) => Promise<string> }> {
  const keyPair = await crypto.subtle.generateKey('Ed25519', true, ['sign', 'verify'])

  // Export public key → multicodec → base58 → did:key
  const publicKeyBytes = new Uint8Array(await crypto.subtle.exportKey('raw', keyPair.publicKey))
  const prefixed = new Uint8Array(2 + publicKeyBytes.length)
  prefixed[0] = 0xed // Ed25519 multicodec
  prefixed[1] = 0x01
  prefixed.set(publicKeyBytes, 2)
  const did = 'did:key:z' + encodeBase58(prefixed)

  const sign = async (data: string): Promise<string> => {
    const signature = await crypto.subtle.sign('Ed25519', keyPair.privateKey, new TextEncoder().encode(data))
    return encodeBase64Url(new Uint8Array(signature))
  }

  return { did, sign }
}

const BASE58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'

function encodeBase58(bytes: Uint8Array): string {
  let num = BigInt(0)
  for (const byte of bytes) {
    num = num * BigInt(256) + BigInt(byte)
  }
  let str = ''
  while (num > 0) {
    const mod = Number(num % BigInt(58))
    str = BASE58_ALPHABET[mod] + str
    num = num / BigInt(58)
  }
  for (const byte of bytes) {
    if (byte === 0) str = '1' + str
    else break
  }
  return str
}

function encodeBase64Url(bytes: Uint8Array): string {
  const binary = String.fromCharCode(...bytes)
  return Buffer.from(binary, 'binary').toString('base64url')
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

/**
 * Register a client with full challenge-response auth.
 * Returns the 'registered' message.
 */
async function registerClient(
  ws: WebSocket,
  identity: { did: string; sign: (data: string) => Promise<string> },
): Promise<RelayMessage> {
  sendMsg(ws, { type: 'register', did: identity.did })

  const challenge = await waitForMessage(ws)
  if (challenge.type !== 'challenge') {
    throw new Error(`Expected challenge, got ${challenge.type}`)
  }

  const signature = await identity.sign(challenge.nonce)
  sendMsg(ws, {
    type: 'challenge-response',
    did: identity.did,
    nonce: challenge.nonce,
    signature,
  })

  return waitForMessage(ws)
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

// --- Tests ---

describe('RelayServer', () => {
  let server: RelayServer
  let alice: { did: string; sign: (data: string) => Promise<string> }
  let bob: { did: string; sign: (data: string) => Promise<string> }

  beforeEach(async () => {
    server = new RelayServer({ port: PORT })
    await server.start()
    alice = await generateIdentity()
    bob = await generateIdentity()
  })

  afterEach(async () => {
    await server.stop()
  })

  describe('challenge-response auth', () => {
    it('should send challenge on register', async () => {
      const ws = await createClient(RELAY_URL)
      sendMsg(ws, { type: 'register', did: alice.did })

      const msg = await waitForMessage(ws)
      expect(msg.type).toBe('challenge')
      if (msg.type === 'challenge') {
        expect(msg.nonce).toBeTruthy()
        expect(msg.nonce.length).toBe(64) // 32 bytes hex
      }

      ws.close()
    })

    it('should confirm registration after valid challenge response', async () => {
      const ws = await createClient(RELAY_URL)
      const msg = await registerClient(ws, alice)

      expect(msg).toEqual({ type: 'registered', did: alice.did, peers: 0 })
      expect(server.connectedDids).toContain(alice.did)

      ws.close()
    })

    it('should reject invalid signature', async () => {
      const ws = await createClient(RELAY_URL)
      sendMsg(ws, { type: 'register', did: alice.did })

      const challenge = await waitForMessage(ws)
      if (challenge.type !== 'challenge') throw new Error('Expected challenge')

      // Sign with Bob's key (wrong key for Alice's DID)
      const wrongSig = await bob.sign(challenge.nonce)
      sendMsg(ws, {
        type: 'challenge-response',
        did: alice.did,
        nonce: challenge.nonce,
        signature: wrongSig,
      })

      const msg = await waitForMessage(ws)
      expect(msg.type).toBe('error')
      if (msg.type === 'error') {
        expect(msg.code).toBe('AUTH_FAILED')
      }

      ws.close()
    })

    it('should reject challenge response without pending challenge', async () => {
      const ws = await createClient(RELAY_URL)
      sendMsg(ws, {
        type: 'challenge-response',
        did: alice.did,
        nonce: 'fake-nonce',
        signature: 'fake-sig',
      })

      const msg = await waitForMessage(ws)
      expect(msg.type).toBe('error')
      if (msg.type === 'error') {
        expect(msg.code).toBe('NO_CHALLENGE')
      }

      ws.close()
    })

    it('should reject invalid DID format', async () => {
      const ws = await createClient(RELAY_URL)
      sendMsg(ws, { type: 'register', did: 'not-a-did' })

      const msg = await waitForMessage(ws)
      expect(msg.type).toBe('error')
      if (msg.type === 'error') {
        expect(msg.code).toBe('INVALID_DID')
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
        expect(bobMsg.envelope.fromDid).toBe(alice.did)
        expect(bobMsg.envelope.toDid).toBe(bob.did)
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

      // Bob connects — challenge + response, then registered + 2 queued messages
      const bobWs = await createClient(RELAY_URL)
      sendMsg(bobWs, { type: 'register', did: bob.did })

      const challenge = await waitForMessage(bobWs)
      expect(challenge.type).toBe('challenge')
      if (challenge.type !== 'challenge') throw new Error('Expected challenge')

      const sig = await bob.sign(challenge.nonce)
      const bobMessages = collectMessages(bobWs, 3) // registered + 2 messages
      sendMsg(bobWs, { type: 'challenge-response', did: bob.did, nonce: challenge.nonce, signature: sig })

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
        expect(msg.code).toBe('INVALID_MESSAGE')
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
      sendMsg(bobDevice2, { type: 'register', did: bob.did })

      const challenge = await waitForMessage(bobDevice2)
      if (challenge.type !== 'challenge') throw new Error('Expected challenge')

      const sig = await bob.sign(challenge.nonce)
      const msgs = collectMessages(bobDevice2, 2)
      sendMsg(bobDevice2, { type: 'challenge-response', did: bob.did, nonce: challenge.nonce, signature: sig })

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

      sendMsg(bobWs, { type: 'ack', messageId: envelope.id })
      await new Promise((r) => setTimeout(r, 50))

      bobWs.close()
      await new Promise((r) => setTimeout(r, 50))

      // Bob reconnects — should NOT get the message again
      const bob2 = await createClient(RELAY_URL)
      const regMsg = await registerClient(bob2, bob)
      expect(regMsg.type).toBe('registered')

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
      await bobPromise // Bob receives but does NOT ACK

      bobWs.close()
      await new Promise((r) => setTimeout(r, 50))

      // Bob reconnects — should get redelivered message after auth
      const bob2 = await createClient(RELAY_URL)
      sendMsg(bob2, { type: 'register', did: bob.did })

      const challenge = await waitForMessage(bob2)
      if (challenge.type !== 'challenge') throw new Error('Expected challenge')

      const sig = await bob.sign(challenge.nonce)
      const msgs = collectMessages(bob2, 2) // registered + redelivered
      sendMsg(bob2, { type: 'challenge-response', did: bob.did, nonce: challenge.nonce, signature: sig })

      const received = await msgs
      expect(received[0].type).toBe('registered')
      expect(received[1].type).toBe('message')
      if (received[1].type === 'message') {
        expect(received[1].envelope.id).toBe(envelope.id)
      }

      aliceWs.close()
      bob2.close()
    })

    it('should ignore ACK from unregistered client', async () => {
      const ws = await createClient(RELAY_URL)
      sendMsg(ws, { type: 'ack', messageId: 'nonexistent' })
      await new Promise((r) => setTimeout(r, 50))

      const aliceWs = await createClient(RELAY_URL)
      const msg = await registerClient(aliceWs, alice)
      expect(msg.type).toBe('registered')

      ws.close()
      aliceWs.close()
    })
  })
})
