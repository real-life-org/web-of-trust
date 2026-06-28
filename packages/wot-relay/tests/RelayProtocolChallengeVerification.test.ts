import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { readFileSync } from 'fs'
import { randomUUID } from 'crypto'
import { fileURLToPath } from 'url'
import { dirname, resolve } from 'path'
import WebSocket from 'ws'
import { RelayServer } from '../src/relay.js'
import type { RelayMessage } from '../src/types.js'
import { protocol } from '@web_of_trust/core'

const {
  encodeBase58,
  encodeBase64Url,
  buildBrokerAuthTranscript,
  createBrokerAuthTranscriptSigningBytes,
  parseBrokerChallengeNonce,
} = protocol

const PORT = 9881
const RELAY_URL = `ws://localhost:${PORT}`

const __dirname = dirname(fileURLToPath(import.meta.url))
const RELAY_SOURCE_PATH = resolve(__dirname, '../src/relay.ts')

// Sync 003 Authentisierung / Broker-Auth-Transcript test identity. Signatures
// are produced over the JCS-canonicalized broker-auth transcript bytes — never
// over the raw nonce string and never over hex bytes.
interface TestIdentity {
  did: string
  signTranscript: (input: { did: string; deviceId: string; nonce: string }) => Promise<string>
  signRawNonceString: (nonce: string) => Promise<string>
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
    signTranscript: async (input) => {
      const transcript = buildBrokerAuthTranscript(input)
      const signingBytes = createBrokerAuthTranscriptSigningBytes(transcript)
      const sig = await crypto.subtle.sign('Ed25519', keyPair.privateKey, signingBytes)
      return encodeBase64Url(new Uint8Array(sig))
    },
    signRawNonceString: async (nonce) => {
      const sig = await crypto.subtle.sign('Ed25519', keyPair.privateKey, new TextEncoder().encode(nonce))
      return encodeBase64Url(new Uint8Array(sig))
    },
  }
}

function createClient(url: string): Promise<WebSocket> {
  return new Promise((resolveP, rejectP) => {
    const ws = new WebSocket(url)
    ws.on('open', () => resolveP(ws))
    ws.on('error', rejectP)
  })
}

function sendRaw(ws: WebSocket, payload: Record<string, unknown>): void {
  ws.send(JSON.stringify(payload))
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

describe('Relay protocol challenge verification (Sync 003 broker-auth-transcript)', () => {
  describe('source guard', () => {
    it('relay.ts must not contain standalone DID/Base58/base64url/WebCrypto verifier code or legacy hex/nonce-string signing', () => {
      const source = readFileSync(RELAY_SOURCE_PATH, 'utf8')
      const forbiddenPatterns: RegExp[] = [
        /BASE58_ALPHABET/,
        /function\s+decodeBase58/,
        /function\s+didToPublicKeyBytes/,
        /function\s+decodeBase64Url/,
        /function\s+verifySignature/,
        /crypto\.subtle\.importKey/,
        /TextEncoder\(\)\.encode\(nonce\)/,
        /randomBytes\(32\)\.toString\(['"]hex['"]\)/,
      ]
      for (const pattern of forbiddenPatterns) {
        expect(source, `relay.ts must not match ${pattern}`).not.toMatch(pattern)
      }
    })

    it('relay.ts must consume shared Sync 003 broker-auth protocol helpers from @web_of_trust/core', () => {
      const source = readFileSync(RELAY_SOURCE_PATH, 'utf8')
      expect(source).toMatch(/from\s+['"]@web_of_trust\/core(?:\/[a-z-]+)?['"]/)
      expect(source).toMatch(/verifyBrokerChallengeResponseControlFrame/)
    })
  })

  describe('challenge-response behavior through Sync 003 protocol helpers', () => {
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

    it('issues a canonical unpadded Base64URL 32-byte nonce in the challenge frame', async () => {
      const ws = await createClient(RELAY_URL)
      const deviceId = randomUUID()
      sendRaw(ws, { type: 'register', did: alice.did, deviceId })

      const challenge = await waitForMessage(ws)
      expect(challenge.type).toBe('challenge')
      if (challenge.type !== 'challenge') throw new Error('Expected challenge')

      // Sync 003: 32 random bytes encoded as canonical unpadded Base64URL → exactly 43 chars.
      expect(challenge.nonce).toMatch(/^[A-Za-z0-9_-]{43}$/)
      expect(() => parseBrokerChallengeNonce(challenge.nonce)).not.toThrow()
      const parsed = parseBrokerChallengeNonce(challenge.nonce)
      expect(parsed.bytes.byteLength).toBe(32)

      ws.close()
    })

    it('accepts a valid challenge-response signed over the JCS Broker-Auth-Transcript bytes', async () => {
      const ws = await createClient(RELAY_URL)
      const deviceId = randomUUID()
      sendRaw(ws, { type: 'register', did: alice.did, deviceId })

      const challenge = await waitForMessage(ws)
      if (challenge.type !== 'challenge') throw new Error('Expected challenge')

      const signature = await alice.signTranscript({
        did: alice.did,
        deviceId,
        nonce: challenge.nonce,
      })

      sendRaw(ws, {
        type: 'challenge-response',
        did: alice.did,
        deviceId,
        nonce: challenge.nonce,
        signature,
      })

      const reply = await waitForMessage(ws)
      expect(reply.type).toBe('registered')
      if (reply.type === 'registered') {
        expect(reply.did).toBe(alice.did)
        expect((reply as unknown as { deviceId: string }).deviceId).toBe(deviceId)
      }

      ws.close()
    })

    it('marks an accepted nonce consumed and rejects same-connection replay as NONCE_REPLAY', async () => {
      const ws = await createClient(RELAY_URL)
      const deviceId = randomUUID()
      sendRaw(ws, { type: 'register', did: alice.did, deviceId })

      const challenge = await waitForMessage(ws)
      if (challenge.type !== 'challenge') throw new Error('Expected challenge')

      const replayedFrame = {
        type: 'challenge-response',
        did: alice.did,
        deviceId,
        nonce: challenge.nonce,
        signature: await alice.signTranscript({
          did: alice.did,
          deviceId,
          nonce: challenge.nonce,
        }),
      }

      sendRaw(ws, replayedFrame)
      const registered = await waitForMessage(ws)
      expect(registered.type).toBe('registered')

      sendRaw(ws, replayedFrame)
      const replay = await waitForMessage(ws)
      expect(replay.type).toBe('error')
      if (replay.type === 'error') {
        expect(replay.code).toBe('NONCE_REPLAY')
      }

      ws.close()
    })

    it('rejects a consumed nonce replay on a new connection as NONCE_REPLAY', async () => {
      const ws = await createClient(RELAY_URL)
      const deviceId = randomUUID()
      sendRaw(ws, { type: 'register', did: alice.did, deviceId })

      const challenge = await waitForMessage(ws)
      if (challenge.type !== 'challenge') throw new Error('Expected challenge')

      const replayedFrame = {
        type: 'challenge-response',
        did: alice.did,
        deviceId,
        nonce: challenge.nonce,
        signature: await alice.signTranscript({
          did: alice.did,
          deviceId,
          nonce: challenge.nonce,
        }),
      }

      sendRaw(ws, replayedFrame)
      const registered = await waitForMessage(ws)
      expect(registered.type).toBe('registered')

      const replayWs = await createClient(RELAY_URL)
      sendRaw(replayWs, replayedFrame)
      const replay = await waitForMessage(replayWs)
      expect(replay.type).toBe('error')
      if (replay.type === 'error') {
        expect(replay.code).toBe('NONCE_REPLAY')
      }

      ws.close()
      replayWs.close()
    })

    it('rejects a consumed nonce before pending-challenge mismatch as NONCE_REPLAY', async () => {
      const ws = await createClient(RELAY_URL)
      const deviceId = randomUUID()
      sendRaw(ws, { type: 'register', did: alice.did, deviceId })

      const challenge = await waitForMessage(ws)
      if (challenge.type !== 'challenge') throw new Error('Expected challenge')

      const replayedFrame = {
        type: 'challenge-response',
        did: alice.did,
        deviceId,
        nonce: challenge.nonce,
        signature: await alice.signTranscript({
          did: alice.did,
          deviceId,
          nonce: challenge.nonce,
        }),
      }

      sendRaw(ws, replayedFrame)
      const registered = await waitForMessage(ws)
      expect(registered.type).toBe('registered')

      const freshWs = await createClient(RELAY_URL)
      sendRaw(freshWs, { type: 'register', did: alice.did, deviceId: randomUUID() })
      const freshChallenge = await waitForMessage(freshWs)
      expect(freshChallenge.type).toBe('challenge')

      sendRaw(freshWs, replayedFrame)
      const replay = await waitForMessage(freshWs)
      expect(replay.type).toBe('error')
      if (replay.type === 'error') {
        expect(replay.code).toBe('NONCE_REPLAY')
      }

      ws.close()
      freshWs.close()
    })

    it('rejects a challenge-response signed over the raw nonce string (legacy behavior) as AUTH_INVALID', async () => {
      const ws = await createClient(RELAY_URL)
      const deviceId = randomUUID()
      sendRaw(ws, { type: 'register', did: alice.did, deviceId })

      const challenge = await waitForMessage(ws)
      if (challenge.type !== 'challenge') throw new Error('Expected challenge')

      // Legacy: Alice signs the raw Base64URL nonce string with the correct DID
      // key. Sync 003 must still reject it because the broker verifies the
      // Broker-Auth-Transcript bytes instead.
      const legacySignature = await alice.signRawNonceString(challenge.nonce)

      sendRaw(ws, {
        type: 'challenge-response',
        did: alice.did,
        deviceId,
        nonce: challenge.nonce,
        signature: legacySignature,
      })

      const reply = await waitForMessage(ws)
      expect(reply.type).toBe('error')
      if (reply.type === 'error') {
        expect(reply.code).toBe('AUTH_INVALID')
      }

      ws.close()
    })

    it('rejects a tampered transcript signature as AUTH_INVALID', async () => {
      const ws = await createClient(RELAY_URL)
      const deviceId = randomUUID()
      sendRaw(ws, { type: 'register', did: alice.did, deviceId })

      const challenge = await waitForMessage(ws)
      if (challenge.type !== 'challenge') throw new Error('Expected challenge')

      const validSig = await alice.signTranscript({
        did: alice.did,
        deviceId,
        nonce: challenge.nonce,
      })
      const tamperedBytes = Buffer.from(validSig, 'base64url')
      tamperedBytes[0] = tamperedBytes[0] ^ 0xff
      const tamperedSig = tamperedBytes.toString('base64url')

      sendRaw(ws, {
        type: 'challenge-response',
        did: alice.did,
        deviceId,
        nonce: challenge.nonce,
        signature: tamperedSig,
      })

      const reply = await waitForMessage(ws)
      expect(reply.type).toBe('error')
      if (reply.type === 'error') {
        expect(reply.code).toBe('AUTH_INVALID')
      }

      ws.close()
    })

    it('rejects a malformed (non-Base64URL / wrong-length) signature as MALFORMED_MESSAGE', async () => {
      const ws = await createClient(RELAY_URL)
      const deviceId = randomUUID()
      sendRaw(ws, { type: 'register', did: alice.did, deviceId })

      const challenge = await waitForMessage(ws)
      if (challenge.type !== 'challenge') throw new Error('Expected challenge')

      sendRaw(ws, {
        type: 'challenge-response',
        did: alice.did,
        deviceId,
        nonce: challenge.nonce,
        signature: '!!!not-valid-base64url!!!',
      })

      const reply = await waitForMessage(ws)
      expect(reply.type).toBe('error')
      if (reply.type === 'error') {
        expect(reply.code).toBe('MALFORMED_MESSAGE')
      }

      ws.close()
    })

    it('rejects a register frame without deviceId as MALFORMED_MESSAGE', async () => {
      const ws = await createClient(RELAY_URL)
      sendRaw(ws, { type: 'register', did: alice.did })

      const reply = await waitForMessage(ws)
      expect(reply.type).toBe('error')
      if (reply.type === 'error') {
        expect(reply.code).toBe('MALFORMED_MESSAGE')
      }

      ws.close()
    })

    it('rejects a register frame whose deviceId is not a canonical lowercase UUID v4 as MALFORMED_MESSAGE', async () => {
      const ws = await createClient(RELAY_URL)
      sendRaw(ws, { type: 'register', did: alice.did, deviceId: 'NOT-A-UUID' })

      const reply = await waitForMessage(ws)
      expect(reply.type).toBe('error')
      if (reply.type === 'error') {
        expect(reply.code).toBe('MALFORMED_MESSAGE')
      }

      ws.close()
    })

    it('rejects a challenge-response with mismatched deviceId before signature verification (AUTH_INVALID)', async () => {
      const ws = await createClient(RELAY_URL)
      const deviceId = randomUUID()
      const otherDeviceId = randomUUID()
      sendRaw(ws, { type: 'register', did: alice.did, deviceId })

      const challenge = await waitForMessage(ws)
      if (challenge.type !== 'challenge') throw new Error('Expected challenge')

      // Sign the transcript for the *wrong* deviceId so the signature itself is valid
      // against that transcript but the pending-challenge binding mismatches.
      const signature = await alice.signTranscript({
        did: alice.did,
        deviceId: otherDeviceId,
        nonce: challenge.nonce,
      })

      sendRaw(ws, {
        type: 'challenge-response',
        did: alice.did,
        deviceId: otherDeviceId,
        nonce: challenge.nonce,
        signature,
      })

      const reply = await waitForMessage(ws)
      expect(reply.type).toBe('error')
      if (reply.type === 'error') {
        expect(reply.code).toBe('AUTH_INVALID')
      }

      ws.close()
    })

    it('rejects a challenge-response with mismatched nonce before signature verification (AUTH_INVALID)', async () => {
      const ws = await createClient(RELAY_URL)
      const deviceId = randomUUID()
      sendRaw(ws, { type: 'register', did: alice.did, deviceId })

      const challenge = await waitForMessage(ws)
      if (challenge.type !== 'challenge') throw new Error('Expected challenge')

      // Fabricate a canonical-shaped nonce that does NOT match the pending challenge.
      const fabricatedNonceBytes = new Uint8Array(32)
      crypto.getRandomValues(fabricatedNonceBytes)
      const fabricatedNonce = encodeBase64Url(fabricatedNonceBytes)

      const signature = await alice.signTranscript({
        did: alice.did,
        deviceId,
        nonce: fabricatedNonce,
      })

      sendRaw(ws, {
        type: 'challenge-response',
        did: alice.did,
        deviceId,
        nonce: fabricatedNonce,
        signature,
      })

      const reply = await waitForMessage(ws)
      expect(reply.type).toBe('error')
      if (reply.type === 'error') {
        expect(reply.code).toBe('AUTH_INVALID')
      }

      ws.close()
    })

    it('rejects a malformed did:key on register', async () => {
      const ws = await createClient(RELAY_URL)
      const deviceId = randomUUID()
      sendRaw(ws, { type: 'register', did: 'did:key:zNotARealMultibaseKey!!!', deviceId })

      const reply = await waitForMessage(ws)
      // Either MALFORMED_MESSAGE at register, or AUTH_INVALID at challenge-response —
      // both are acceptable rejections for an invalid did:key.
      if (reply.type === 'error') {
        expect(['MALFORMED_MESSAGE', 'AUTH_INVALID']).toContain(reply.code)
      } else if (reply.type === 'challenge') {
        const signature = await alice.signTranscript({
          did: 'did:key:zNotARealMultibaseKey!!!',
          deviceId,
          nonce: reply.nonce,
        })
        sendRaw(ws, {
          type: 'challenge-response',
          did: 'did:key:zNotARealMultibaseKey!!!',
          deviceId,
          nonce: reply.nonce,
          signature,
        })
        const second = await waitForMessage(ws)
        expect(second.type).toBe('error')
        if (second.type === 'error') {
          expect(['MALFORMED_MESSAGE', 'AUTH_INVALID']).toContain(second.code)
        }
      } else {
        throw new Error(`Unexpected reply type: ${reply.type}`)
      }

      ws.close()
    })
  })
})
