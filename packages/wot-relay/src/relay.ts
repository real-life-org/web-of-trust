import { createServer, type Server as HttpServer } from 'http'
import { randomBytes } from 'crypto'
import { WebSocketServer, type WebSocket } from 'ws'
import type { ClientMessage, RelayMessage } from './types.js'
import { OfflineQueue } from './queue.js'
import { getDashboardHtml } from './dashboard-html.js'

export interface RelayServerOptions {
  port: number
  dbPath?: string // SQLite path, defaults to ':memory:' for tests
}

/** Pending challenge awaiting response from client */
interface PendingChallenge {
  did: string
  nonce: string
  createdAt: number
}

const CHALLENGE_TIMEOUT_MS = 30_000 // 30 seconds to respond
const BASE58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'

function decodeBase58(input: string): Uint8Array {
  let num = BigInt(0)
  for (const char of input) {
    const index = BASE58_ALPHABET.indexOf(char)
    if (index === -1) throw new Error(`Invalid Base58 character: ${char}`)
    num = num * BigInt(58) + BigInt(index)
  }
  const hex = num.toString(16)
  const hexPadded = hex.length % 2 ? '0' + hex : hex
  const bytes: number[] = []
  for (let i = 0; i < hexPadded.length; i += 2) {
    bytes.push(parseInt(hexPadded.slice(i, i + 2), 16))
  }
  let leadingZeros = 0
  for (const char of input) {
    if (char === '1') leadingZeros++
    else break
  }
  return new Uint8Array([...new Array(leadingZeros).fill(0), ...bytes])
}

function decodeBase64Url(input: string): Uint8Array {
  const base64 = input.replace(/-/g, '+').replace(/_/g, '/')
  const padded = base64 + '='.repeat((4 - (base64.length % 4)) % 4)
  const binary = Buffer.from(padded, 'base64')
  return new Uint8Array(binary)
}

/** Extract Ed25519 public key bytes from did:key */
function didToPublicKeyBytes(did: string): Uint8Array {
  if (!did.startsWith('did:key:z')) {
    throw new Error('Invalid did:key format')
  }
  const multibase = did.slice('did:key:z'.length)
  const prefixedKey = decodeBase58(multibase)
  if (prefixedKey[0] !== 0xed || prefixedKey[1] !== 0x01) {
    throw new Error('Invalid multicodec prefix for Ed25519')
  }
  return prefixedKey.slice(2)
}

/** Verify an Ed25519 signature over a message */
async function verifySignature(publicKeyBytes: Uint8Array, signature: Uint8Array, message: Uint8Array): Promise<boolean> {
  const publicKey = await crypto.subtle.importKey(
    'raw',
    publicKeyBytes as any,
    { name: 'Ed25519' },
    false,
    ['verify'],
  )
  return crypto.subtle.verify('Ed25519', publicKey, signature as any, message as any)
}

export class RelayServer {
  private wss: WebSocketServer | null = null
  private httpServer: HttpServer | null = null
  private connections = new Map<string, Set<WebSocket>>() // DID → Set of WebSockets (multi-device)
  private socketToDid = new Map<WebSocket, string>() // WebSocket → DID (reverse lookup)
  private pendingChallenges = new Map<WebSocket, PendingChallenge>()
  private queue: OfflineQueue
  private startedAt = Date.now()

  constructor(private options: RelayServerOptions) {
    this.queue = new OfflineQueue(options.dbPath)
  }

  async start(): Promise<void> {
    return new Promise((resolve) => {
      // Create HTTP server for dashboard + health endpoints
      this.httpServer = createServer((req, res) => {
        // CORS
        res.setHeader('Access-Control-Allow-Origin', '*')
        res.setHeader('Access-Control-Allow-Methods', 'GET')

        if (req.url === '/health') {
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ status: 'ok' }))
        } else if (req.url === '/dashboard') {
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
          res.end(getDashboardHtml())
        } else if (req.url === '/dashboard/data') {
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify(this.getStats()))
        } else {
          res.writeHead(404)
          res.end('Not Found')
        }
      })

      // Attach WebSocket server to HTTP server
      this.wss = new WebSocketServer({ server: this.httpServer })

      this.wss.on('connection', (ws) => {
        this.handleConnection(ws)
      })

      this.httpServer.listen(this.options.port, () => {
        resolve()
      })
    })
  }

  async stop(): Promise<void> {
    for (const sockets of this.connections.values()) {
      for (const ws of sockets) ws.close()
    }
    this.connections.clear()
    this.socketToDid.clear()
    this.pendingChallenges.clear()

    if (this.wss) {
      await new Promise<void>((resolve) => {
        this.wss!.close(() => resolve())
      })
      this.wss = null
    }

    if (this.httpServer) {
      await new Promise<void>((resolve) => {
        this.httpServer!.close(() => resolve())
      })
      this.httpServer = null
    }

    this.queue.close()
  }

  get port(): number {
    return this.options.port
  }

  get connectedDids(): string[] {
    return [...this.connections.keys()]
  }

  getStats(): Record<string, unknown> {
    const dids = this.connectedDids
    const devicesPerDid: Record<string, number> = {}
    let totalConnections = 0
    for (const [did, sockets] of this.connections) {
      devicesPerDid[did] = sockets.size
      totalConnections += sockets.size
    }

    return {
      uptimeSeconds: Math.floor((Date.now() - this.startedAt) / 1000),
      connectedDids: dids,
      connectionCount: totalConnections,
      devicesPerDid,
      queueStats: {
        total: this.queue.count(),
        byDid: this.queue.countByDid(),
      },
      memoryMB: process.memoryUsage().rss / (1024 * 1024),
    }
  }

  private handleConnection(ws: WebSocket): void {
    ws.on('message', (data) => {
      try {
        const msg = JSON.parse(data.toString()) as ClientMessage
        this.handleMessage(ws, msg)
      } catch {
        this.sendTo(ws, {
          type: 'error',
          code: 'INVALID_MESSAGE',
          message: 'Invalid JSON',
        })
      }
    })

    ws.on('close', () => {
      this.pendingChallenges.delete(ws)
      const did = this.socketToDid.get(ws)
      if (did) {
        const sockets = this.connections.get(did)
        if (sockets) {
          sockets.delete(ws)
          if (sockets.size === 0) this.connections.delete(did)
        }
        this.socketToDid.delete(ws)
      }
    })
  }

  private handleMessage(ws: WebSocket, msg: ClientMessage): void {
    switch (msg.type) {
      case 'register':
        this.handleRegister(ws, msg.did)
        break
      case 'challenge-response':
        this.handleChallengeResponse(ws, msg.did, msg.nonce, msg.signature)
        break
      case 'send':
        this.handleSend(ws, msg.envelope)
        break
      case 'ack':
        this.handleAck(ws, msg.messageId)
        break
      case 'ping':
        this.sendTo(ws, { type: 'pong' })
        break
    }
  }

  /**
   * Step 1: Client sends register → Relay responds with challenge nonce.
   * The client must sign the nonce with their Ed25519 private key.
   */
  private handleRegister(ws: WebSocket, did: string): void {
    // Validate DID format
    if (!did.startsWith('did:key:z')) {
      this.sendTo(ws, { type: 'error', code: 'INVALID_DID', message: 'DID must be did:key format' })
      return
    }

    // Generate random nonce
    const nonce = randomBytes(32).toString('hex')

    // Store pending challenge
    this.pendingChallenges.set(ws, { did, nonce, createdAt: Date.now() })

    // Send challenge to client
    this.sendTo(ws, { type: 'challenge', nonce })
  }

  /**
   * Step 2: Client signs the nonce and sends it back.
   * Relay verifies the signature against the DID's public key.
   */
  private async handleChallengeResponse(ws: WebSocket, did: string, nonce: string, signature: string): Promise<void> {
    const pending = this.pendingChallenges.get(ws)

    if (!pending) {
      this.sendTo(ws, { type: 'error', code: 'NO_CHALLENGE', message: 'No pending challenge. Send register first.' })
      return
    }

    // Check timeout
    if (Date.now() - pending.createdAt > CHALLENGE_TIMEOUT_MS) {
      this.pendingChallenges.delete(ws)
      this.sendTo(ws, { type: 'error', code: 'CHALLENGE_EXPIRED', message: 'Challenge expired. Send register again.' })
      return
    }

    // Check DID and nonce match
    if (did !== pending.did || nonce !== pending.nonce) {
      this.pendingChallenges.delete(ws)
      this.sendTo(ws, { type: 'error', code: 'CHALLENGE_MISMATCH', message: 'DID or nonce does not match the pending challenge.' })
      return
    }

    // Verify signature
    try {
      const publicKeyBytes = didToPublicKeyBytes(did)
      const signatureBytes = decodeBase64Url(signature)
      const nonceBytes = new TextEncoder().encode(nonce)
      const valid = await verifySignature(publicKeyBytes, signatureBytes, nonceBytes)

      if (!valid) {
        this.pendingChallenges.delete(ws)
        this.sendTo(ws, { type: 'error', code: 'AUTH_FAILED', message: 'Signature verification failed. You do not own this DID.' })
        return
      }
    } catch (err) {
      this.pendingChallenges.delete(ws)
      this.sendTo(ws, { type: 'error', code: 'AUTH_ERROR', message: `Verification error: ${err instanceof Error ? err.message : String(err)}` })
      return
    }

    // Auth successful — complete registration
    this.pendingChallenges.delete(ws)
    this.completeRegistration(ws, did)
  }

  /**
   * Complete the registration after successful auth.
   * Delivers queued messages to the newly authenticated client.
   */
  private completeRegistration(ws: WebSocket, did: string): void {
    // Support multiple devices per DID
    let sockets = this.connections.get(did)
    if (!sockets) {
      sockets = new Set()
      this.connections.set(did, sockets)
    }
    sockets.add(ws)
    this.socketToDid.set(ws, did)

    this.sendTo(ws, { type: 'registered', did, peers: sockets.size - 1 })

    // First: get previously delivered but unACKed messages (redelivery)
    const unacked = this.queue.getUnacked(did)
    for (const envelope of unacked) {
      this.sendTo(ws, { type: 'message', envelope })
    }

    // Then: deliver newly queued messages (marks them as 'delivered')
    const queued = this.queue.dequeue(did)
    for (const envelope of queued) {
      this.sendTo(ws, { type: 'message', envelope })
    }
  }

  private handleSend(ws: WebSocket, envelope: Record<string, unknown>): void {
    const senderDid = this.socketToDid.get(ws)
    if (!senderDid) {
      this.sendTo(ws, {
        type: 'error',
        code: 'NOT_REGISTERED',
        message: 'Must register before sending',
      })
      return
    }

    const toDid = envelope.toDid as string | undefined
    if (!toDid) {
      this.sendTo(ws, {
        type: 'error',
        code: 'MISSING_RECIPIENT',
        message: 'Envelope must have toDid field',
      })
      return
    }

    const messageId = (envelope.id as string) ?? 'unknown'
    const now = new Date().toISOString()

    // Try to deliver to all connected devices of recipient. For self-addressed
    // multi-device sync, exclude the sending socket: the sender already applied
    // the change locally, and ACKing its own echo would delete the queued copy
    // before offline sibling devices can receive it on reconnect.
    const recipientSockets = this.connections.get(toDid)
    const targetSockets = recipientSockets
      ? [...recipientSockets].filter((recipientWs) => toDid !== senderDid || recipientWs !== ws)
      : []
    if (targetSockets.length > 0) {
      for (const recipientWs of targetSockets) {
        this.sendTo(recipientWs, { type: 'message', envelope })
      }

      // Persist until ACK — enqueue as 'queued' then immediately mark 'delivered'
      this.queue.enqueue(toDid, envelope)
      this.queue.markDelivered(messageId)

      // Notify sender: delivered
      this.sendTo(ws, {
        type: 'receipt',
        receipt: { messageId, status: 'delivered', timestamp: now },
      })
    } else {
      // Queue for offline delivery
      this.queue.enqueue(toDid, envelope)

      // Notify sender: accepted (queued)
      this.sendTo(ws, {
        type: 'receipt',
        receipt: { messageId, status: 'accepted', timestamp: now },
      })
    }
  }

  private handleAck(ws: WebSocket, messageId: string): void {
    const did = this.socketToDid.get(ws)
    if (!did) return // Not registered — ignore
    this.queue.ack(messageId)
  }

  private sendTo(ws: WebSocket, msg: RelayMessage): void {
    if (ws.readyState === ws.OPEN) {
      ws.send(JSON.stringify(msg))
    }
  }
}
