import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { WebSocketMessagingAdapter } from '../src/adapters/messaging/WebSocketMessagingAdapter'
import { formatBrokerChallengeNonce } from '../src/protocol/sync/broker-auth-nonce'

// #251 re-review (dual-broker): the multiplexer's dial timeout calls
// child.disconnect() and its reconnect loop then starts a NEW connect(). The
// old socket is still alive at that point — its late events (open / challenge
// signing completing / registered / close) must neither mutate the adapter's
// state for the NEW socket nor write frames onto it. A `this.ws !== null`
// guard is NOT enough once the new socket occupies this.ws; every handler and
// every send must be bound to its own socket INSTANCE. disconnect() must also
// settle a pending connect() deterministically — after the teardown the old
// socket's events are dead, so nothing else would ever settle that promise.

const DID = 'did:key:z6MkTestIdentity'
const DEVICE_ID = '0b6f3f2e-1111-4222-8333-444455556666'
// Valid Sync 003 nonces (32 bytes, canonical unpadded Base64URL) — the
// challenge path canonicalizes the nonce and throws on anything shorter.
const NONCE_A = formatBrokerChallengeNonce(new Uint8Array(32).fill(1))
const NONCE_B = formatBrokerChallengeNonce(new Uint8Array(32).fill(2))

class FakeSocket {
  static OPEN = 1
  static CONNECTING = 0
  static CLOSING = 2
  static CLOSED = 3
  static instances: FakeSocket[] = []
  readyState = FakeSocket.CONNECTING
  sent: Array<Record<string, unknown>> = []
  closed = false
  onopen: (() => void) | null = null
  onmessage: ((event: { data: string }) => void) | null = null
  onerror: (() => void) | null = null
  onclose: (() => void) | null = null
  constructor(public url: string) {
    FakeSocket.instances.push(this)
  }
  send(data: string): void {
    this.sent.push(JSON.parse(data) as Record<string, unknown>)
  }
  close(): void {
    this.closed = true
    this.readyState = FakeSocket.CLOSED
  }
  // test drivers
  open(): void {
    this.readyState = FakeSocket.OPEN
    this.onopen?.()
  }
  frame(obj: Record<string, unknown>): void {
    this.onmessage?.({ data: JSON.stringify(obj) })
  }
  types(): unknown[] {
    return this.sent.map((f) => f.type)
  }
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

/** Signer whose next N calls hang until release() — models the async challenge gap. */
function deferredSigner() {
  const pending: Array<(sig: Uint8Array) => void> = []
  let deferCount = 0
  const signer = () => {
    if (deferCount > 0) {
      deferCount--
      return new Promise<Uint8Array>((resolve) => pending.push(resolve))
    }
    return Promise.resolve(new Uint8Array(64))
  }
  return {
    signer,
    deferNext: () => {
      deferCount++
    },
    release: () => pending.shift()?.(new Uint8Array(64)),
  }
}

function makeAdapter(signer: () => Promise<Uint8Array>) {
  return new WebSocketMessagingAdapter('ws://relay.test', {
    deviceId: DEVICE_ID,
    signBrokerAuthTranscript: signer,
  })
}

async function connectFully(adapter: WebSocketMessagingAdapter, nonce: string, peers = 1) {
  const promise = adapter.connect(DID)
  const socket = FakeSocket.instances[FakeSocket.instances.length - 1]
  socket.open()
  socket.frame({ type: 'challenge', nonce })
  await flush()
  socket.frame({ type: 'registered', did: DID, deviceId: DEVICE_ID, isNewDevice: false, peers })
  await promise
  return socket
}

describe('WebSocketMessagingAdapter socket-instance guard (#251)', () => {
  beforeEach(() => {
    FakeSocket.instances = []
    vi.stubGlobal('WebSocket', FakeSocket)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('disconnect() settles a pending connect() deterministically', async () => {
    const adapter = makeAdapter(deferredSigner().signer)
    const dial = adapter.connect(DID) // socket stays CONNECTING — a hung dial
    const rejection = expect(dial).rejects.toThrow('disconnected before registration')
    await adapter.disconnect()
    await rejection
    expect(adapter.getState()).toBe('disconnected')
    expect(FakeSocket.instances[0].closed).toBe(true)
  })

  it('a challenge-response whose signing completes after teardown+redial goes NOWHERE', async () => {
    const { signer, deferNext, release } = deferredSigner()
    const adapter = makeAdapter(signer)

    // Socket A: dial, receive challenge, signing hangs (async gap).
    deferNext()
    const dialA = adapter.connect(DID)
    const socketA = FakeSocket.instances[0]
    socketA.open()
    socketA.frame({ type: 'challenge', nonce: NONCE_A })
    await flush()
    expect(socketA.types()).toEqual(['register'])

    // Multiplexer dial timeout: teardown, then redial → socket B authenticates fully.
    const rejection = expect(dialA).rejects.toThrow('disconnected before registration')
    await adapter.disconnect()
    await rejection
    const socketB = await connectFully(adapter, NONCE_B)
    expect(adapter.getState()).toBe('connected')
    expect(socketB.types()).toEqual(['register', 'challenge-response'])

    // The OLD signing completes late: its response must hit neither A nor B —
    // on B it would carry the wrong nonce and poison the fresh registration.
    release()
    await flush()
    expect(socketA.types()).toEqual(['register'])
    expect(socketB.types()).toEqual(['register', 'challenge-response'])
    expect(socketB.sent[1].nonce).toBe(NONCE_B)
    expect(adapter.getState()).toBe('connected')
  })

  it('late registered/close from the replaced socket do not touch the new connection', async () => {
    const { signer } = deferredSigner()
    const adapter = makeAdapter(signer)

    // Socket A: opens + registers, then silence (auth never completes).
    const dialA = adapter.connect(DID)
    const socketA = FakeSocket.instances[0]
    socketA.open()
    const rejection = expect(dialA).rejects.toThrow('disconnected before registration')
    await adapter.disconnect()
    await rejection

    await connectFully(adapter, NONCE_B, 3)
    expect(adapter.getState()).toBe('connected')
    expect(adapter.getPeerCount()).toBe(3)

    // Late 'registered' from A must not overwrite the live connection's facts.
    socketA.frame({ type: 'registered', did: DID, deviceId: DEVICE_ID, isNewDevice: false, peers: 99 })
    expect(adapter.getState()).toBe('connected')
    expect(adapter.getPeerCount()).toBe(3)

    // Late 'close' from A must not flip the live connection to 'disconnected'
    // (the outbox timer and the multiplexer reconnect loop key off this state).
    socketA.onclose?.()
    expect(adapter.getState()).toBe('connected')
  })

  it('a late open from the replaced socket sends no register frame anywhere', async () => {
    const { signer } = deferredSigner()
    const adapter = makeAdapter(signer)

    const dialA = adapter.connect(DID) // A never opens before the teardown
    const socketA = FakeSocket.instances[0]
    const rejection = expect(dialA).rejects.toThrow('disconnected before registration')
    await adapter.disconnect()
    await rejection

    const socketB = await connectFully(adapter, NONCE_B)

    // A's open fires late (raced the close). Unguarded this sent a SECOND
    // register — over this.ws, i.e. onto B, which the relay forbids.
    socketA.readyState = FakeSocket.OPEN
    socketA.onopen?.()
    await flush()
    expect(socketA.sent).toEqual([])
    expect(socketB.types()).toEqual(['register', 'challenge-response'])
    expect(adapter.getState()).toBe('connected')
  })
})
