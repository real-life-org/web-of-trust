import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { readFileSync } from 'fs'
import { fileURLToPath } from 'url'
import { dirname, resolve } from 'path'
import WebSocket from 'ws'
import { RelayServer } from '../src/relay.js'
import type { RelayMessage, ClientMessage } from '../src/types.js'
import { protocol } from '@web_of_trust/core'

const { encodeBase58, encodeBase64Url } = protocol

const PORT = 9881
const RELAY_URL = `ws://localhost:${PORT}`

const __dirname = dirname(fileURLToPath(import.meta.url))
const RELAY_SOURCE_PATH = resolve(__dirname, '../src/relay.ts')

interface TestIdentity {
  did: string
  sign: (data: string) => Promise<string>
}

async function generateIdentity(): Promise<TestIdentity> {
  const keyPair = await crypto.subtle.generateKey('Ed25519', true, ['sign', 'verify'])
  const publicKeyBytes = new Uint8Array(await crypto.subtle.exportKey('raw', keyPair.publicKey))
  const prefixed = new Uint8Array(2 + publicKeyBytes.length)
  prefixed[0] = 0xed
  prefixed[1] = 0x01
  prefixed.set(publicKeyBytes, 2)
  const did = 'did:key:z' + encodeBase58(prefixed)

  return {
    did,
    sign: async (data: string) => {
      const sig = await crypto.subtle.sign('Ed25519', keyPair.privateKey, new TextEncoder().encode(data))
      return encodeBase64Url(new Uint8Array(sig))
    },
  }
}

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
  return new Promise((resolveP, rejectP) => {
    const timer = setTimeout(() => rejectP(new Error('Timeout waiting for message')), timeout)
    ws.once('message', (data) => {
      clearTimeout(timer)
      resolveP(JSON.parse(data.toString()) as RelayMessage)
    })
  })
}

describe('Relay protocol challenge verification', () => {
  describe('source guard', () => {
    it('relay.ts must not contain standalone DID/Base58/base64url/WebCrypto challenge verification code', () => {
      const source = readFileSync(RELAY_SOURCE_PATH, 'utf8')
      const forbiddenPatterns: RegExp[] = [
        /BASE58_ALPHABET/,
        /function\s+decodeBase58/,
        /function\s+didToPublicKeyBytes/,
        /function\s+decodeBase64Url/,
        /function\s+verifySignature/,
        /crypto\.subtle\.importKey/,
      ]
      for (const pattern of forbiddenPatterns) {
        expect(source, `relay.ts must not match ${pattern}`).not.toMatch(pattern)
      }
    })

    it('relay.ts must import shared protocol helpers from @web_of_trust/core', () => {
      const source = readFileSync(RELAY_SOURCE_PATH, 'utf8')
      expect(source).toMatch(/from\s+['"]@web_of_trust\/core['"]/)
    })
  })

  describe('challenge-response behavior through protocol helpers', () => {
    let server: RelayServer
    let alice: TestIdentity

    beforeEach(async () => {
      server = new RelayServer({ port: PORT })
      await server.start()
      alice = await generateIdentity()
    })

    afterEach(async () => {
      await server.stop()
    })

    it('accepts a valid challenge-response signed over nonce string bytes', async () => {
      const ws = await createClient(RELAY_URL)
      sendMsg(ws, { type: 'register', did: alice.did })

      const challenge = await waitForMessage(ws)
      expect(challenge.type).toBe('challenge')
      if (challenge.type !== 'challenge') throw new Error('Expected challenge')

      const signature = await alice.sign(challenge.nonce)
      sendMsg(ws, {
        type: 'challenge-response',
        did: alice.did,
        nonce: challenge.nonce,
        signature,
      })

      const reply = await waitForMessage(ws)
      expect(reply.type).toBe('registered')
      if (reply.type === 'registered') {
        expect(reply.did).toBe(alice.did)
      }

      ws.close()
    })

    it('rejects a tampered signature with AUTH_FAILED', async () => {
      const ws = await createClient(RELAY_URL)
      sendMsg(ws, { type: 'register', did: alice.did })

      const challenge = await waitForMessage(ws)
      if (challenge.type !== 'challenge') throw new Error('Expected challenge')

      const validSig = await alice.sign(challenge.nonce)
      const tamperedBytes = Buffer.from(validSig, 'base64url')
      tamperedBytes[0] = tamperedBytes[0] ^ 0xff
      const tamperedSig = tamperedBytes.toString('base64url')

      sendMsg(ws, {
        type: 'challenge-response',
        did: alice.did,
        nonce: challenge.nonce,
        signature: tamperedSig,
      })

      const reply = await waitForMessage(ws)
      expect(reply.type).toBe('error')
      if (reply.type === 'error') {
        expect(reply.code).toBe('AUTH_FAILED')
      }

      ws.close()
    })

    it('rejects a malformed base64url signature with AUTH_ERROR', async () => {
      const ws = await createClient(RELAY_URL)
      sendMsg(ws, { type: 'register', did: alice.did })

      const challenge = await waitForMessage(ws)
      if (challenge.type !== 'challenge') throw new Error('Expected challenge')

      sendMsg(ws, {
        type: 'challenge-response',
        did: alice.did,
        nonce: challenge.nonce,
        signature: '!!!not-valid-base64url!!!',
      })

      const reply = await waitForMessage(ws)
      expect(reply.type).toBe('error')
      if (reply.type === 'error') {
        expect(['AUTH_ERROR', 'AUTH_FAILED']).toContain(reply.code)
      }

      ws.close()
    })

    it('rejects a malformed did:key on register', async () => {
      const ws = await createClient(RELAY_URL)
      sendMsg(ws, { type: 'register', did: 'did:key:zNotARealMultibaseKey!!!' })

      const reply = await waitForMessage(ws)
      // Either INVALID_DID at register, or AUTH_ERROR at challenge-response —
      // both are acceptable rejections for an invalid did:key. What is NOT
      // acceptable is silent acceptance.
      if (reply.type === 'error') {
        expect(['INVALID_DID', 'AUTH_ERROR']).toContain(reply.code)
      } else if (reply.type === 'challenge') {
        const sig = await alice.sign(reply.nonce)
        sendMsg(ws, {
          type: 'challenge-response',
          did: 'did:key:zNotARealMultibaseKey!!!',
          nonce: reply.nonce,
          signature: sig,
        })
        const second = await waitForMessage(ws)
        expect(second.type).toBe('error')
        if (second.type === 'error') {
          expect(['AUTH_ERROR', 'AUTH_FAILED', 'CHALLENGE_MISMATCH']).toContain(second.code)
        }
      } else {
        throw new Error(`Unexpected reply type: ${reply.type}`)
      }

      ws.close()
    })
  })
})
