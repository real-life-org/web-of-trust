import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { WebSocketMessagingAdapter } from '../src/adapters/messaging/WebSocketMessagingAdapter'
import { MultiBrokerMessagingAdapter } from '../src/adapters/messaging/MultiBrokerMessagingAdapter'
import { formatBrokerChallengeNonce } from '../src/protocol/sync/broker-auth-nonce'

// Issue #355 (Cold-Start-Messlauf): eine WS-Verbindung zu wss://relay.web-of-trust.de
// blieb dauerhaft in 'connecting' — weder open noch close ueber ~40 min. Der
// MultiBrokerMessagingAdapter hat einen 8s-Dial-Timeout, der direkte
// WebSocketMessagingAdapter hatte KEINEN: ein Endpoint, der den TCP/TLS-Handshake
// annimmt aber nie antwortet, liess connect() ewig pending und den Socket ewig
// offen. Diese Suite pinnt den abbrechbaren Connect-Timeout im Adapter selbst:
// (a) das Connect-Promise settled (reject mit Timeout-Fehler),
// (b) der Socket ist danach geschlossen,
// (c) nach einem Retry existiert maximal ein aktiver Dial.

const DID = 'did:key:z6MkTestIdentity'
const DEVICE_ID = '0b6f3f2e-1111-4222-8333-444455556666'
const NONCE_A = formatBrokerChallengeNonce(new Uint8Array(32).fill(1))

// Adapter-Default (8s, Groessenordnung des MultiBroker-Werts) — lokal gespiegelt,
// damit die Tests die Zeitachse exakt treffen.
const CONNECT_TIMEOUT_MS = 8_000

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

const signer = () => Promise.resolve(new Uint8Array(64))

function makeAdapter(options?: { connectTimeoutMs?: number }) {
  return new WebSocketMessagingAdapter('ws://relay.test', {
    deviceId: DEVICE_ID,
    signBrokerAuthTranscript: signer,
    ...options,
  })
}

/** Drive a full connect() to 'connected' under fake timers, return the socket. */
async function connectFully(adapter: WebSocketMessagingAdapter, nonce: string) {
  const promise = adapter.connect(DID)
  const socket = FakeSocket.instances[FakeSocket.instances.length - 1]
  socket.open()
  socket.frame({ type: 'challenge', nonce })
  // Flush the async broker-auth signing microtask (challenge-response send).
  await vi.advanceTimersByTimeAsync(0)
  socket.frame({ type: 'registered', did: DID, deviceId: DEVICE_ID, isNewDevice: false, peers: 1 })
  await promise
  return socket
}

describe('WebSocketMessagingAdapter connect timeout (#355)', () => {
  beforeEach(() => {
    FakeSocket.instances = []
    vi.stubGlobal('WebSocket', FakeSocket)
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  // --- Kern-Regression: nicht-antwortender Endpoint (alle drei Nachbedingungen) ---
  it('a dial to a never-responding endpoint rejects, closes the socket, and a retry has exactly one active dial', async () => {
    const adapter = makeAdapter()
    const dial = adapter.connect(DID)
    // Der Socket bleibt in CONNECTING — genau das 40-min-Symptom aus dem Messlauf.
    const rejection = expect(dial).rejects.toThrow(/timeout/i)
    await vi.advanceTimersByTimeAsync(CONNECT_TIMEOUT_MS + 1)

    // (a) Das Connect-Promise settled mit einem Timeout-Fehler — kein ewiges Pending.
    await rejection
    // (b) Der Socket ist danach geschlossen; der Adapter meldet 'disconnected'.
    const socketA = FakeSocket.instances[0]
    expect(socketA.closed).toBe(true)
    expect(adapter.getState()).toBe('disconnected')

    // (c) Ein Retry oeffnet EINEN neuen Socket; der alte ist tot — maximal ein
    // aktiver Dial zur selben URL.
    const socketB = await connectFully(adapter, NONCE_A)
    expect(FakeSocket.instances).toHaveLength(2)
    const active = FakeSocket.instances.filter((s) => !s.closed)
    expect(active).toEqual([socketB])
    expect(adapter.getState()).toBe('connected')
  })

  it('a late open from the timed-out socket sends nothing and does not disturb the retry', async () => {
    const adapter = makeAdapter()
    const dial = adapter.connect(DID)
    const socketA = FakeSocket.instances[0]
    const rejection = expect(dial).rejects.toThrow(/timeout/i)
    await vi.advanceTimersByTimeAsync(CONNECT_TIMEOUT_MS + 1)
    await rejection

    const socketB = await connectFully(adapter, NONCE_A)

    // A's open feuert verspaetet (Race mit dem close) — darf weder auf A noch
    // auf B einen register-Frame schreiben noch den State kippen.
    socketA.readyState = FakeSocket.OPEN
    socketA.onopen?.()
    await vi.advanceTimersByTimeAsync(0)
    expect(socketA.sent).toEqual([])
    expect(socketB.types()).toEqual(['register', 'challenge-response'])
    expect(adapter.getState()).toBe('connected')
  })

  it('connectTimeoutMs is configurable', async () => {
    const adapter = makeAdapter({ connectTimeoutMs: 500 })
    const dial = adapter.connect(DID)
    const rejection = expect(dial).rejects.toThrow(/timeout/i)
    await vi.advanceTimersByTimeAsync(501)
    await rejection
    expect(FakeSocket.instances[0].closed).toBe(true)
  })

  it('a successful registration disarms the timeout — no late kill of the live connection', async () => {
    const adapter = makeAdapter()
    const socket = await connectFully(adapter, NONCE_A)
    expect(adapter.getState()).toBe('connected')

    // Weit ueber das Timeout-Fenster hinaus: der Timer wurde beim 'registered'
    // entschaerft und darf die stehende Verbindung nicht mehr toeten.
    await vi.advanceTimersByTimeAsync(CONNECT_TIMEOUT_MS * 2)
    expect(adapter.getState()).toBe('connected')
    expect(socket.closed).toBe(false)
  })

  it('connectTimeoutMs <= 0 disables the timeout (dial stays pending)', async () => {
    const adapter = makeAdapter({ connectTimeoutMs: 0 })
    let settled = false
    const dial = adapter.connect(DID).finally(() => { settled = true })
    await vi.advanceTimersByTimeAsync(CONNECT_TIMEOUT_MS * 10)
    expect(settled).toBe(false)
    expect(FakeSocket.instances[0].closed).toBe(false)
    // Aufraeumen: disconnect() settled den Dial deterministisch (Bestand aus #251).
    const rejection = expect(dial).rejects.toThrow('disconnected before registration')
    await adapter.disconnect()
    await rejection
  })

  it('a retry WHILE the previous dial still hangs replaces it — never two parallel sockets', async () => {
    const adapter = makeAdapter()
    const dialA = adapter.connect(DID)
    const socketA = FakeSocket.instances[0]
    const rejectionA = expect(dialA).rejects.toThrow(/superseded/)

    // Retry vor dem Timeout: der haengende Dial wird ERSETZT, nicht dupliziert.
    const socketB = await connectFully(adapter, NONCE_A)
    await rejectionA
    expect(socketA.closed).toBe(true)
    expect(FakeSocket.instances.filter((s) => !s.closed)).toEqual([socketB])

    // A's Timeout-Fenster verstreicht — der alte Timer darf B nicht toeten.
    await vi.advanceTimersByTimeAsync(CONNECT_TIMEOUT_MS + 1)
    expect(adapter.getState()).toBe('connected')
    expect(socketB.closed).toBe(false)
  })

  // --- #358: Settlement ist gegen werfende State-Subscriber garantiert ---
  it('the connect promise settles even when a state subscriber throws (socket stays closed)', async () => {
    const adapter = makeAdapter()
    // Wirft gezielt beim Timeout-Teardown ('disconnected') — ein Wurf schon bei
    // 'connecting' wuerde den Dial-Start selbst scheitern lassen.
    adapter.onStateChange((state) => {
      if (state === 'disconnected') throw new Error('subscriber boom')
    })
    const dial = adapter.connect(DID)
    const socket = FakeSocket.instances[0]
    const rejection = expect(dial).rejects.toThrow(/connect timeout/)
    await vi.advanceTimersByTimeAsync(CONNECT_TIMEOUT_MS + 1)
    await rejection
    expect(socket.closed).toBe(true)
  })
})

// --- #359: Der MultiBroker-Timeout bleibt gegenueber dem Child-Default autoritativ ---
describe('MultiBrokerMessagingAdapter keeps timeout authority over WebSocket children (#359)', () => {
  beforeEach(() => {
    FakeSocket.instances = []
    vi.stubGlobal('WebSocket', FakeSocket)
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('a MultiBroker connectTimeoutMs > 8s is honored — the child does NOT abort at its 8s default', async () => {
    const child = makeAdapter() // Default 8s — muss vom Parent entwaffnet werden.
    const multi = new MultiBrokerMessagingAdapter([child], { connectTimeoutMs: 12_000, reconnectIntervalMs: 0 })
    const dial = multi.connect(DID)
    const socket = FakeSocket.instances[0]
    const rejection = expect(dial).rejects.toThrow(/connect timeout after 12000ms/)

    // Bei 9s (nach dem Child-Default) lebt der Dial noch — die Hoheit liegt aussen.
    await vi.advanceTimersByTimeAsync(9_000)
    expect(socket.closed).toBe(false)

    // Erst der MultiBroker-Timer (12s) reisst den Dial ab (disconnect()-Abbruch).
    await vi.advanceTimersByTimeAsync(3_001)
    await rejection
    expect(socket.closed).toBe(true)
  })

  it('a child dial started BEFORE the MultiBroker wraps it loses its old 8s timer (in-flight re-arm)', async () => {
    const child = makeAdapter() // Default 8s
    const dial = child.connect(DID) // Dial startet VOR dem MultiBroker-Konstruktor
    const socket = FakeSocket.instances[0]
    // Der Konstruktor entwaffnet auch den bereits laufenden Timer (#359-Re-Review).
    new MultiBrokerMessagingAdapter([child], { connectTimeoutMs: 0, reconnectIntervalMs: 0 })

    let settled = false
    // EINE Kette: die finally-abgeleitete Promise wird unten via expect gehandhabt
    // — eine ge-void-ete Ableitung waere beim Aufraeum-Reject ein Unhandled.
    const trackedDial = dial.finally(() => { settled = true })
    await vi.advanceTimersByTimeAsync(CONNECT_TIMEOUT_MS * 10)
    expect(settled).toBe(false)
    expect(socket.closed).toBe(false)

    // Aufraeumen: disconnect() settled den Dial deterministisch.
    const rejection = expect(trackedDial).rejects.toThrow()
    await child.disconnect()
    await rejection
  })

  it('MultiBroker connectTimeoutMs: 0 disables the dial timeout entirely — the child default must not fire', async () => {
    const child = makeAdapter()
    const multi = new MultiBrokerMessagingAdapter([child], { connectTimeoutMs: 0, reconnectIntervalMs: 0 })
    let settled = false
    const dial = multi.connect(DID).finally(() => { settled = true })
    const socket = FakeSocket.instances[0]

    await vi.advanceTimersByTimeAsync(CONNECT_TIMEOUT_MS * 10)
    expect(settled).toBe(false)
    expect(socket.closed).toBe(false)

    // Aufraeumen: disconnect() settled den Dial deterministisch.
    const rejection = expect(dial).rejects.toThrow()
    await multi.disconnect()
    await rejection
  })
})
