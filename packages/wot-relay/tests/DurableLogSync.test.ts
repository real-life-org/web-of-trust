import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { randomUUID } from 'crypto'
import WebSocket from 'ws'
import { RelayServer } from '../src/relay.js'
import type { RelayMessage } from '../src/types.js'
import { protocol, WebCryptoProtocolCryptoAdapter } from '@web_of_trust/core'

// Slice R / Sync 002 — durable-log catch-up on the REAL relay (mirrors sync-spike
// probe 01). Producers push real log-entry JWS, then DISCONNECT; a fresh device
// connects AFTER they are gone and reconstructs the full document via a
// sync-request served from the durable log (NOT live broadcast). That ordering is
// the teeth: it proves durability, not realtime fan-out.

const PORT = 9884
const RELAY_URL = `ws://localhost:${PORT}`
const FIXED_TIMESTAMP = '2026-06-22T10:00:00Z'

// Vector-validated WebCrypto adapter for SHA-256 / Ed25519 key derivation. The
// global `crypto` (Node WebCrypto) is used directly for detached subtle signing.
const cryptoAdapter = new WebCryptoProtocolCryptoAdapter()
const {
  buildBrokerAuthTranscript,
  createBrokerAuthTranscriptSigningBytes,
  formatBrokerChallengeResponseSignature,
} = protocol

// --- raw-seed identity (needed to PRODUCE valid log-entry JWS) ---------------

interface RawIdentity {
  seed: Uint8Array
  did: string
  authorKid: string
  deviceId: string
  signTranscriptBytes: (bytes: Uint8Array) => Promise<Uint8Array>
}

// RFC 8410 PKCS8 prefix for an Ed25519 private key, so a raw 32-byte seed can be
// imported into WebCrypto for detached signing. The same seed yields the same
// public key as core's ed25519PublicKeyFromSeed (noble), so the broker verifies
// these transcript signatures against the seed-derived did:key. The log-entry
// JWS itself is signed by core (createLogEntryJws), not here.
const ED25519_PKCS8_PREFIX = Uint8Array.from([
  0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x04, 0x22, 0x04, 0x20,
])

async function seedToSigningKey(seed: Uint8Array) {
  const pkcs8 = new Uint8Array(ED25519_PKCS8_PREFIX.length + seed.length)
  pkcs8.set(ED25519_PKCS8_PREFIX)
  pkcs8.set(seed, ED25519_PKCS8_PREFIX.length)
  return crypto.subtle.importKey('pkcs8', pkcs8, { name: 'Ed25519' }, false, ['sign'])
}

async function makeRawIdentity(label: string): Promise<RawIdentity> {
  const seed = await cryptoAdapter.sha256(new TextEncoder().encode(`durable-sync-test/seed/${label}`))
  const pub = await cryptoAdapter.ed25519PublicKeyFromSeed(seed)
  const did = protocol.publicKeyToDidKey(pub)
  const signingKey = await seedToSigningKey(seed)
  return {
    seed,
    did,
    authorKid: `${did}#sig-0`,
    deviceId: randomUUID(),
    signTranscriptBytes: async (bytes) =>
      new Uint8Array(await crypto.subtle.sign('Ed25519', signingKey, bytes)),
  }
}

async function deriveSpaceContentKey(docId: string, generation = 0): Promise<Uint8Array> {
  return cryptoAdapter.sha256(new TextEncoder().encode(`sck|${docId}|gen${generation}`))
}

// --- minimal authenticated relay client over ws ------------------------------

type SendOutcome = Record<string, unknown> | { error: string; clientHint?: string }

class TestClient {
  private ws: WebSocket | null = null
  readonly messages: Record<string, unknown>[] = []
  /** FIFO of resolvers for the next receipt-or-error (sends are awaited serially). */
  private outcomeWaiters: Array<(outcome: SendOutcome) => void> = []
  private messageWaiters: Array<(env: Record<string, unknown>) => void> = []

  constructor(private identity: RawIdentity) {}

  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(RELAY_URL)
      this.ws = ws
      ws.on('open', () => {
        ws.send(JSON.stringify({ type: 'register', did: this.identity.did, deviceId: this.identity.deviceId }))
      })
      ws.on('message', (data) => {
        const msg = JSON.parse(data.toString()) as RelayMessage
        switch (msg.type) {
          case 'challenge': {
            const transcript = buildBrokerAuthTranscript({
              did: this.identity.did,
              deviceId: this.identity.deviceId,
              nonce: msg.nonce,
            })
            const signingBytes = createBrokerAuthTranscriptSigningBytes(transcript)
            this.identity
              .signTranscriptBytes(signingBytes)
              .then((sig) => {
                ws.send(
                  JSON.stringify({
                    type: 'challenge-response',
                    did: this.identity.did,
                    deviceId: this.identity.deviceId,
                    nonce: msg.nonce,
                    signature: formatBrokerChallengeResponseSignature(sig),
                  }),
                )
              })
              .catch(reject)
            break
          }
          case 'registered':
            resolve()
            break
          case 'message': {
            this.messages.push(msg.envelope)
            const waiter = this.messageWaiters.shift()
            if (waiter) waiter(msg.envelope)
            break
          }
          case 'receipt': {
            const waiter = this.outcomeWaiters.shift()
            if (waiter) waiter(msg.receipt as unknown as Record<string, unknown>)
            break
          }
          case 'error': {
            const waiter = this.outcomeWaiters.shift()
            if (waiter) waiter({ error: msg.code, clientHint: msg.clientHint })
            break
          }
        }
      })
      ws.on('error', reject)
    })
  }

  /** Send a transport envelope; resolves on the matching receipt OR an error. */
  send(envelope: Record<string, unknown>): Promise<SendOutcome> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Timeout waiting for send outcome')), 2000)
      this.outcomeWaiters.push((outcome) => {
        clearTimeout(timer)
        resolve(outcome)
      })
      this.ws!.send(JSON.stringify({ type: 'send', envelope }))
    })
  }

  /** Send a sync-request and wait for the sync-response message envelope. */
  syncRequest(envelope: Record<string, unknown>): Promise<Record<string, unknown>> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Timeout waiting for sync-response')), 2000)
      this.messageWaiters.push((env) => {
        clearTimeout(timer)
        resolve(env)
      })
      this.ws!.send(JSON.stringify({ type: 'send', envelope }))
    })
  }

  disconnect(): Promise<void> {
    return new Promise((resolve) => {
      if (!this.ws) return resolve()
      this.ws.on('close', () => resolve())
      this.ws.close()
      this.ws = null
    })
  }
}

// --- log-entry / sync-request envelope builders ------------------------------

async function buildLogEntryJws(params: {
  identity: RawIdentity
  docId: string
  seq: number
  plaintext: string
  keyGeneration?: number
  /** Override the payload deviceId (defaults to the signer's own). Used by the
   *  VE-3a test to forge an entry that claims ANOTHER device's namespace while
   *  still being validly signed by this identity's authorKid. */
  deviceId?: string
}): Promise<string> {
  const generation = params.keyGeneration ?? 0
  const deviceId = params.deviceId ?? params.identity.deviceId
  const spaceContentKey = await deriveSpaceContentKey(params.docId, generation)
  const enc = await protocol.encryptLogPayload({
    crypto: cryptoAdapter,
    spaceContentKey,
    deviceId,
    seq: params.seq,
    plaintext: new TextEncoder().encode(params.plaintext),
  })
  const payload = {
    seq: params.seq,
    deviceId,
    docId: params.docId,
    authorKid: params.identity.authorKid,
    keyGeneration: generation,
    data: enc.blobBase64Url,
    timestamp: FIXED_TIMESTAMP,
  }
  return protocol.createLogEntryJws({ payload, signingSeed: params.identity.seed })
}

function logEntryEnvelope(from: string, to: string[], entryJws: string): Record<string, unknown> {
  return protocol.createLogEntryMessage({
    id: randomUUID(),
    from,
    to,
    createdTime: Math.floor(Date.now() / 1000),
    entry: entryJws,
  }) as unknown as Record<string, unknown>
}

function syncRequestEnvelope(
  from: string,
  docId: string,
  heads: Record<string, number>,
  limit?: number,
): Record<string, unknown> {
  return protocol.createSyncRequestMessage({
    id: randomUUID(),
    from,
    createdTime: Math.floor(Date.now() / 1000),
    body: limit === undefined ? { docId, heads } : { docId, heads, limit },
  }) as unknown as Record<string, unknown>
}

/** Decrypt + collect plaintexts from a list of log-entry JWS (verifies signatures). */
async function reconstruct(jwsList: string[], docId: string): Promise<string[]> {
  const out: string[] = []
  for (const jws of jwsList) {
    const payload = await protocol.verifyLogEntryJws(jws, { crypto: cryptoAdapter })
    const key = await deriveSpaceContentKey(payload.docId, payload.keyGeneration)
    const blob = protocol.decodeBase64Url(payload.data)
    const plaintext = await protocol.decryptLogPayload({ crypto: cryptoAdapter, spaceContentKey: key, blob })
    expect(payload.docId).toBe(docId)
    out.push(new TextDecoder().decode(plaintext))
  }
  return out
}

describe('Durable log sync over the real relay (Slice R / Sync 002)', () => {
  let server: RelayServer

  beforeEach(async () => {
    server = new RelayServer({ port: PORT })
    await server.start()
  })

  afterEach(async () => {
    await server.stop()
  })

  it('cold reconstruction: a fresh device rebuilds the full doc via sync-request after all producers disconnect', async () => {
    const docId = randomUUID()
    const alice = await makeRawIdentity('alice')
    const bob = await makeRawIdentity('bob')
    const fresh = await makeRawIdentity('fresh')

    const aliceClient = new TestClient(alice)
    const bobClient = new TestClient(bob)
    await aliceClient.connect()
    await bobClient.connect()

    // Two producer devices push several log entries (interleaved devices).
    const written: { jws: string; text: string }[] = []
    const writeFrom = async (producer: TestClient, id: RawIdentity, seq: number, text: string) => {
      const jws = await buildLogEntryJws({ identity: id, docId, seq, plaintext: text })
      written.push({ jws, text })
      const res = await producer.send(logEntryEnvelope(id.did, [fresh.did], jws))
      expect((res as Record<string, unknown>).status).toBe('delivered')
    }

    await writeFrom(aliceClient, alice, 0, 'alice-0')
    await writeFrom(bobClient, bob, 0, 'bob-0')
    await writeFrom(aliceClient, alice, 1, 'alice-1')
    await writeFrom(aliceClient, alice, 2, 'alice-2')
    await writeFrom(bobClient, bob, 1, 'bob-1')

    // Producers go away BEFORE the fresh device connects — reconstruction must
    // come from the durable log, not from any live broadcast.
    await aliceClient.disconnect()
    await bobClient.disconnect()
    expect(server.connectedDids).toHaveLength(0)

    // Fresh device authenticates and asks for the full log (EMPTY heads).
    const freshClient = new TestClient(fresh)
    await freshClient.connect()
    const response = await freshClient.syncRequest(syncRequestEnvelope(fresh.did, docId, {}))

    expect(response.type).toBe(protocol.SYNC_RESPONSE_MESSAGE_TYPE)
    const body = response.body as { docId: string; entries: string[]; heads: Record<string, number>; truncated: boolean }
    expect(body.docId).toBe(docId)
    expect(body.truncated).toBe(false)
    expect(body.entries).toHaveLength(written.length)
    expect(body.heads).toEqual({ [alice.deviceId]: 2, [bob.deviceId]: 1 })

    // The fresh device decrypts + reconstructs the exact content written.
    const reconstructed = await reconstruct(body.entries, docId)
    expect(new Set(reconstructed)).toEqual(new Set(written.map((w) => w.text)))

    await freshClient.disconnect()
  })

  it('cold reconstruction survives a producer reconnect (durable, no delete-on-ACK)', async () => {
    const docId = randomUUID()
    const alice = await makeRawIdentity('alice2')
    const fresh = await makeRawIdentity('fresh2')

    const aliceClient = new TestClient(alice)
    await aliceClient.connect()
    const jws0 = await buildLogEntryJws({ identity: alice, docId, seq: 0, plaintext: 'persist-0' })
    await aliceClient.send(logEntryEnvelope(alice.did, [fresh.did], jws0))
    await aliceClient.disconnect()

    // First fresh device reconstructs.
    const fresh1 = new TestClient(fresh)
    await fresh1.connect()
    const r1 = await fresh1.syncRequest(syncRequestEnvelope(fresh.did, docId, {}))
    expect((r1.body as { entries: string[] }).entries).toHaveLength(1)
    await fresh1.disconnect()

    // A SECOND fresh device (different deviceId) reconstructs identically — the
    // log was not consumed/deleted by serving the first catch-up.
    const fresh2Id = await makeRawIdentity('fresh2b')
    const fresh2 = new TestClient(fresh2Id)
    await fresh2.connect()
    const r2 = await fresh2.syncRequest(syncRequestEnvelope(fresh2Id.did, docId, {}))
    const entries2 = (r2.body as { entries: string[] }).entries
    expect(entries2).toHaveLength(1)
    expect(await reconstruct(entries2, docId)).toEqual(['persist-0'])
    await fresh2.disconnect()
  })

  it('rejects a divergent entry at an already-used (deviceId,seq) with SEQ_COLLISION_DETECTED and keeps it out of the log', async () => {
    const docId = randomUUID()
    const alice = await makeRawIdentity('alice3')
    const fresh = await makeRawIdentity('fresh3')

    const aliceClient = new TestClient(alice)
    await aliceClient.connect()

    // Accept seq 0.
    const jws0 = await buildLogEntryJws({ identity: alice, docId, seq: 0, plaintext: 'original-0' })
    const ok = await aliceClient.send(logEntryEnvelope(alice.did, [fresh.did], jws0))
    expect((ok as Record<string, unknown>).status).toBe('delivered')

    // Idempotent retransmission of the SAME content → no error, delivered, no dup.
    const again = await aliceClient.send(logEntryEnvelope(alice.did, [fresh.did], jws0))
    expect((again as Record<string, unknown>).status).toBe('delivered')

    // Divergent entry at the SAME (deviceId, seq=0) → reject.
    const jws0b = await buildLogEntryJws({ identity: alice, docId, seq: 0, plaintext: 'DIVERGENT-0' })
    const rejected = await aliceClient.send(logEntryEnvelope(alice.did, [fresh.did], jws0b))
    expect(rejected).toMatchObject({ error: 'SEQ_COLLISION_DETECTED', clientHint: 'restore-clone-required' })

    await aliceClient.disconnect()

    // The divergent entry never reached the durable log: catch-up serves exactly
    // ONE entry, and it is the original content.
    const freshClient = new TestClient(fresh)
    await freshClient.connect()
    const response = await freshClient.syncRequest(syncRequestEnvelope(fresh.did, docId, {}))
    const body = response.body as { entries: string[] }
    expect(body.entries).toHaveLength(1)
    expect(await reconstruct(body.entries, docId)).toEqual(['original-0'])
    await freshClient.disconnect()
  })

  it('serves an incremental catch-up page when the fresh device already has some heads', async () => {
    const docId = randomUUID()
    const alice = await makeRawIdentity('alice4')
    const fresh = await makeRawIdentity('fresh4')

    const aliceClient = new TestClient(alice)
    await aliceClient.connect()
    const texts = ['c0', 'c1', 'c2']
    for (let seq = 0; seq < texts.length; seq += 1) {
      const jws = await buildLogEntryJws({ identity: alice, docId, seq, plaintext: texts[seq] })
      await aliceClient.send(logEntryEnvelope(alice.did, [fresh.did], jws))
    }
    await aliceClient.disconnect()

    const freshClient = new TestClient(fresh)
    await freshClient.connect()
    // Already have alice@0 → expect only c1, c2.
    const response = await freshClient.syncRequest(
      syncRequestEnvelope(fresh.did, docId, { [alice.deviceId]: 0 }),
    )
    const body = response.body as { entries: string[]; truncated: boolean }
    expect(body.truncated).toBe(false)
    expect(await reconstruct(body.entries, docId)).toEqual(['c1', 'c2'])
    await freshClient.disconnect()
  })

  it('a durable-log WRITE failure during ingest yields INTERNAL_ERROR to the sender and does not crash the relay', async () => {
    const docId = randomUUID()
    const alice = await makeRawIdentity('alice-dberr')
    const fresh = await makeRawIdentity('fresh-dberr')
    const aliceClient = new TestClient(alice)
    await aliceClient.connect()

    // Simulate a transient SQLite failure (SQLITE_IOERR / disk-full / closed
    // handle) on the durable write. Before the fix this threw inside a
    // fire-and-forget `void handleLogEntry(...)`, producing an unhandled rejection
    // (process crash on Node 22) and leaving the sender's send() to hang. vitest
    // would also fail the run on the stray unhandled rejection.
    const docLog = (server as unknown as { docLog: { appendEntry: (...a: unknown[]) => void } }).docLog
    const realAppend = docLog.appendEntry.bind(docLog)
    docLog.appendEntry = () => {
      throw new Error('SQLITE_IOERR: simulated disk failure')
    }

    const jws = await buildLogEntryJws({ identity: alice, docId, seq: 0, plaintext: 'will-fail' })
    const outcome = await aliceClient.send(logEntryEnvelope(alice.did, [fresh.did], jws))
    expect(outcome).toMatchObject({ error: 'INTERNAL_ERROR' })

    // The relay is still alive and serving: restore the store, and a subsequent
    // write at the same (deviceId,seq) succeeds (the failed write stored nothing).
    docLog.appendEntry = realAppend
    const jws2 = await buildLogEntryJws({ identity: alice, docId, seq: 0, plaintext: 'recovered-0' })
    const ok = await aliceClient.send(logEntryEnvelope(alice.did, [fresh.did], jws2))
    expect((ok as Record<string, unknown>).status).toBe('delivered')
    await aliceClient.disconnect()
  })

  it('a durable-log READ failure during sync-request yields INTERNAL_ERROR and does not crash the relay', async () => {
    const docId = randomUUID()
    const fresh = await makeRawIdentity('fresh-syncerr')
    const freshClient = new TestClient(fresh)
    await freshClient.connect()

    const docLog = (server as unknown as {
      docLog: { getSinceWithTruncation: (...a: unknown[]) => unknown }
    }).docLog
    const realGet = docLog.getSinceWithTruncation.bind(docLog)
    docLog.getSinceWithTruncation = () => {
      throw new Error('SQLITE_IOERR: simulated read failure')
    }

    // sync-request runs through handleSyncRequest synchronously; a throw is caught
    // by the handleMessage safety net and reported as INTERNAL_ERROR, not a crash.
    // Use send() (resolves on receipt OR error) since no sync-response will arrive.
    const outcome = await freshClient.send(syncRequestEnvelope(fresh.did, docId, {}))
    expect(outcome).toMatchObject({ error: 'INTERNAL_ERROR' })

    // Still alive: restore and a real sync-request succeeds (empty doc → no entries).
    docLog.getSinceWithTruncation = realGet
    const response = await freshClient.syncRequest(syncRequestEnvelope(fresh.did, docId, {}))
    expect((response.body as { entries: string[] }).entries).toEqual([])
    await freshClient.disconnect()
  })

  it("VE-3a: a foreign author cannot squat another device's (docId,deviceId); cold reconstruction holds only the owner", async () => {
    const docId = randomUUID()
    const alice = await makeRawIdentity('alice-bind')
    const bob = await makeRawIdentity('bob-bind')
    const fresh = await makeRawIdentity('fresh-bind')

    const aliceClient = new TestClient(alice)
    const bobClient = new TestClient(bob)
    await aliceClient.connect()
    await bobClient.connect()

    // Alice owns (docId, alice.deviceId) by writing seq 0.
    const a0 = await buildLogEntryJws({ identity: alice, docId, seq: 0, plaintext: 'alice-0' })
    expect(
      ((await aliceClient.send(logEntryEnvelope(alice.did, [fresh.did], a0))) as Record<string, unknown>).status,
    ).toBe('delivered')

    // Bob signs with his OWN authorKid but claims Alice's deviceId — a forged
    // squat. verifyLogEntryJws passes (valid Bob signature), but the relay's
    // author-binding rejects both a new seq and Alice's existing seq 0.
    const bobAtAliceSeq1 = await buildLogEntryJws({ identity: bob, docId, seq: 1, plaintext: 'bob-1', deviceId: alice.deviceId })
    expect(await bobClient.send(logEntryEnvelope(bob.did, [fresh.did], bobAtAliceSeq1))).toMatchObject({ error: 'AUTHOR_MISMATCH' })

    const bobAtAliceSeq0 = await buildLogEntryJws({ identity: bob, docId, seq: 0, plaintext: 'bob-0', deviceId: alice.deviceId })
    expect(await bobClient.send(logEntryEnvelope(bob.did, [fresh.did], bobAtAliceSeq0))).toMatchObject({ error: 'AUTHOR_MISMATCH' })

    await aliceClient.disconnect()
    await bobClient.disconnect()

    // Cold reconstruction contains ONLY Alice's entry — the log was not poisoned.
    const freshClient = new TestClient(fresh)
    await freshClient.connect()
    const response = await freshClient.syncRequest(syncRequestEnvelope(fresh.did, docId, {}))
    const body = response.body as { entries: string[] }
    expect(body.entries).toHaveLength(1)
    expect(await reconstruct(body.entries, docId)).toEqual(['alice-0'])
    await freshClient.disconnect()
  })
})
