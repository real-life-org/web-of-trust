import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest'
import { WebSocketMessagingAdapter } from '../src/adapters/messaging/WebSocketMessagingAdapter'
import {
  ControlFrameRejectedError,
  createPresentCapabilityControlFrame,
  createSpaceCapabilityJws,
  createSpaceRotateMessage,
  formatBrokerChallengeNonce,
} from '../src/protocol'
import { WebCryptoProtocolCryptoAdapter } from '../src/adapters/protocol-crypto'

const VALID_NONCE = formatBrokerChallengeNonce(new Uint8Array(32).fill(5))

/**
 * VE-9/VE-11: the WS adapter's `sendControlFrame` sends a CLOSED top-level frame
 * (NOT a `send` envelope) and correlates the relay receipt/error by docId.
 */

const crypto = new WebCryptoProtocolCryptoAdapter()
const SPACE_ID = '11111111-1111-4111-8111-111111111111'
const DID = 'did:key:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK'

/**
 * Minimal fake WebSocket that drives the adapter's connect() auth handshake to
 * `connected`, captures sent frames, and lets the test push relay frames.
 */
class FakeWebSocket {
  static OPEN = 1
  static CONNECTING = 0
  static CLOSED = 3
  readyState = FakeWebSocket.CONNECTING
  onopen: (() => void) | null = null
  onmessage: ((event: { data: string }) => void) | null = null
  onerror: (() => void) | null = null
  onclose: (() => void) | null = null
  sent: string[] = []

  constructor(public url: string) {
    queueMicrotask(() => {
      this.readyState = FakeWebSocket.OPEN
      this.onopen?.()
    })
  }
  send(data: string): void {
    this.sent.push(data)
    const msg = JSON.parse(data)
    // Drive the auth handshake: register → challenge → challenge-response → registered.
    if (msg.type === 'register') {
      queueMicrotask(() => this.push({ type: 'challenge', nonce: VALID_NONCE }))
    }
    if (msg.type === 'challenge-response') {
      queueMicrotask(() =>
        this.push({ type: 'registered', did: msg.did, deviceId: msg.deviceId, isNewDevice: true }),
      )
    }
  }
  push(frame: unknown): void {
    this.onmessage?.({ data: JSON.stringify(frame) })
  }
  close(): void {
    this.readyState = FakeWebSocket.CLOSED
    this.onclose?.()
  }
}

let originalWebSocket: unknown

beforeEach(() => {
  originalWebSocket = (globalThis as { WebSocket?: unknown }).WebSocket
  ;(globalThis as { WebSocket: unknown }).WebSocket = FakeWebSocket as unknown
})

afterEach(() => {
  ;(globalThis as { WebSocket: unknown }).WebSocket = originalWebSocket
  vi.restoreAllMocks()
})

async function connectedAdapter(): Promise<{ adapter: WebSocketMessagingAdapter; socket: FakeWebSocket }> {
  const adapter = new WebSocketMessagingAdapter('ws://unused', {
    deviceId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    signBrokerAuthTranscript: async () => new Uint8Array(64).fill(1),
    sendTimeoutMs: 200,
  })
  await adapter.connect(DID)
  const socket = (adapter as unknown as { ws: FakeWebSocket }).ws
  return { adapter, socket }
}

async function presentFrame(): Promise<ReturnType<typeof createPresentCapabilityControlFrame>> {
  const signingSeed = new Uint8Array(32).fill(9)
  const now = new Date()
  const capabilityJws = await createSpaceCapabilityJws({
    payload: {
      type: 'capability',
      spaceId: SPACE_ID,
      audience: DID,
      permissions: ['read', 'write'],
      generation: 0,
      issuedAt: now.toISOString(),
      validUntil: new Date(now.getTime() + 60_000).toISOString(),
    },
    signingSeed,
  })
  return createPresentCapabilityControlFrame({ capabilityJws })
}

describe('WebSocketMessagingAdapter.sendControlFrame (VE-9/VE-11)', () => {
  it('sends the frame verbatim (not a send envelope) and resolves on the matching receipt', async () => {
    const { adapter, socket } = await connectedAdapter()
    const frame = await presentFrame()

    const promise = adapter.sendControlFrame(frame)
    // The frame was sent as the top-level message, NOT wrapped in { type:'send', envelope }.
    const lastSent = JSON.parse(socket.sent[socket.sent.length - 1])
    expect(lastSent.type).toBe('present-capability')
    expect(lastSent.capabilityJws).toBe(frame.capabilityJws)

    // Relay answers with a receipt keyed by docId.
    socket.push({ type: 'receipt', receipt: { messageId: SPACE_ID, status: 'delivered', timestamp: 't' } })
    const receipt = await promise
    expect(receipt).toEqual({ messageId: SPACE_ID, status: 'delivered', timestamp: 't' })
  })

  it('rejects with ControlFrameRejectedError carrying the broker code on an error frame', async () => {
    const { adapter, socket } = await connectedAdapter()
    const frame = await presentFrame()

    const promise = adapter.sendControlFrame(frame)
    socket.push({ type: 'error', thid: SPACE_ID, code: 'CAPABILITY_EXPIRED', message: 'expired' })

    await expect(promise).rejects.toBeInstanceOf(ControlFrameRejectedError)
    await promise.catch((err: ControlFrameRejectedError) => {
      expect(err.code).toBe('CAPABILITY_EXPIRED')
    })
  })

  it('a log-entry receipt (keyed by envelope id) does NOT resolve a pending control frame', async () => {
    const { adapter, socket } = await connectedAdapter()
    const frame = await presentFrame()
    const promise = adapter.sendControlFrame(frame)

    // A receipt for a DIFFERENT messageId (an envelope UUID) must not resolve the
    // control-frame waiter (docId-keyed).
    socket.push({ type: 'receipt', receipt: { messageId: 'some-envelope-uuid', status: 'delivered', timestamp: 't' } })
    // The control-frame promise is still pending; resolve it properly now.
    socket.push({ type: 'receipt', receipt: { messageId: SPACE_ID, status: 'delivered', timestamp: 't2' } })
    const receipt = await promise
    expect(receipt.timestamp).toBe('t2')
  })

  // ── CONCERN-2 (Group 6): per-docId serialization of control frames ────────────
  it('CONCERN-2 — a same-docId space-rotate does NOT overwrite an in-flight present-capability waiter (no spurious timeout)', async () => {
    const { adapter, socket } = await connectedAdapter()
    const present = await presentFrame()
    // A space-rotate frame for the SAME docId (spaceId), constructed independently
    // (out-of-band, as YjsReplicationAdapter.sendSpaceRotate does).
    const rotate = await createSpaceRotateMessage({
      spaceId: SPACE_ID,
      newSpaceCapabilityVerificationKey: 'AAAA',
      newGeneration: 1,
      kid: `${DID}#sig-0`,
      signingSeed: new Uint8Array(32).fill(3),
    })

    // Send present-capability (waiter set for docId), THEN — before its receipt —
    // an out-of-band rotate for the SAME docId. With per-docId serialization the
    // rotate QUEUES behind present-capability instead of clobbering its waiter.
    const presentPromise = adapter.sendControlFrame(present)
    const rotatePromise = adapter.sendControlFrame(rotate)

    // Only present-capability has been written so far (rotate is queued).
    const writtenTypes = socket.sent.map((s) => JSON.parse(s).type)
    expect(writtenTypes.filter((t) => t === 'present-capability')).toHaveLength(1)
    expect(writtenTypes).not.toContain('space-rotate')

    // The relay answers present-capability first → its waiter (NOT the rotate's)
    // resolves. If the rotate had clobbered the docId waiter, this receipt would
    // resolve the rotate and present-capability would time out.
    socket.push({ type: 'receipt', receipt: { messageId: SPACE_ID, status: 'delivered', timestamp: 'p' } })
    const presentReceipt = await presentPromise
    expect(presentReceipt.timestamp).toBe('p')

    // Now the rotate is dequeued + written; its receipt resolves it.
    await Promise.resolve()
    expect(socket.sent.map((s) => JSON.parse(s).type)).toContain('space-rotate')
    socket.push({ type: 'receipt', receipt: { messageId: SPACE_ID, status: 'delivered', timestamp: 'r' } })
    const rotateReceipt = await rotatePromise
    expect(rotateReceipt.timestamp).toBe('r')
  })

  it('CONCERN-2 TEETH — without per-docId serialization, a same-docId second frame overwrites the first waiter (single-slot Map)', async () => {
    // Demonstrates the underlying hazard the serialization fixes: the receipt
    // correlation Map holds ONE waiter per docId. Two raw concurrent sets for the
    // same docId leave only the LAST waiter; the first can never resolve.
    const waiters = new Map<string, string>()
    waiters.set(SPACE_ID, 'present-capability-waiter')
    // A second same-docId frame (rotate) registered WITHOUT serialization:
    waiters.set(SPACE_ID, 'rotate-waiter') // clobbers the present waiter
    expect(waiters.get(SPACE_ID)).toBe('rotate-waiter')
    expect(waiters.size).toBe(1) // the present-capability waiter is lost ⇒ timeout
  })
})

/**
 * #236 (TC4): a write-path `error` frame with thid === envelope.id settles the
 * pending send() promise IMMEDIATELY with a typed 'failed' receipt instead of
 * running into the receipt timeout — AND the frame still fans out to the message
 * path exactly once (semantic ownership stays with routeWritePathError).
 */
describe('#236 write-path error settles pending send()', () => {
  function logEntryEnvelope(id: string) {
    return {
      typ: 'application/didcomm-plain+json',
      type: 'https://web-of-trust.de/protocols/log-entry/1.0',
      id,
      from: DID,
      to: [DID],
      created_time: 1,
      body: { entry: 'x.y.z' },
    }
  }

  it('settles the send promise with a failed receipt (no timeout wait) and still fans out once', async () => {
    const { adapter, socket } = await connectedAdapter()
    const received: unknown[] = []
    adapter.onMessage((envelope) => { received.push(envelope) })

    const envelope = logEntryEnvelope('11111111-2222-4333-8444-555555555555')
    const sendPromise = adapter.send(envelope as never)

    // Relay rejects the write with a thid-correlated error (log-entry reject family).
    socket.push({ type: 'error', thid: envelope.id, code: 'CAPABILITY_REQUIRED', message: 'no scope' })

    // Resolves typed and immediately — with sendTimeoutMs=200 a timeout-driven path
    // would REJECT; a resolve with status 'failed' proves the thid path settled it.
    const receipt = await sendPromise
    expect(receipt.status).toBe('failed')
    expect(receipt.reason).toBe('CAPABILITY_REQUIRED')
    expect(receipt.messageId).toBe(envelope.id)

    // The frame STILL reached the message path exactly once (semantic owner).
    expect(received).toHaveLength(1)
    expect((received[0] as { code?: string }).code).toBe('CAPABILITY_REQUIRED')
  })

  it('control-frame waiter keeps priority: a thid matching a pending control frame never touches pendingReceipts', async () => {
    const { adapter, socket } = await connectedAdapter()
    const received: unknown[] = []
    adapter.onMessage((envelope) => { received.push(envelope) })
    const frame = await presentFrame()

    const promise = adapter.sendControlFrame(frame)
    socket.push({ type: 'error', thid: SPACE_ID, code: 'CAPABILITY_EXPIRED', message: 'expired' })

    await expect(promise).rejects.toBeInstanceOf(ControlFrameRejectedError)
    // Consumed by the waiter — NOT fanned out to the message path.
    expect(received).toHaveLength(0)
  })

  it('an error WITHOUT thid leaves the pending send on the timeout path (no heuristic matching)', async () => {
    const { adapter, socket } = await connectedAdapter()
    const envelope = logEntryEnvelope('99999999-2222-4333-8444-555555555555')
    const sendPromise = adapter.send(envelope as never)

    // e.g. a JWS-verify AUTH_INVALID carries no thid — must not settle the send.
    socket.push({ type: 'error', code: 'AUTH_INVALID', message: 'bad jws' })

    // The send now runs into the (short, 200ms) receipt timeout and REJECTS —
    // proving the no-thid error did not settle it.
    await expect(sendPromise).rejects.toThrow(/Send timeout/)
  })
})
