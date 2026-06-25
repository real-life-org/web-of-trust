import { createServer, type IncomingMessage, type ServerResponse, type Server } from 'node:http'
import { protocol, WebCryptoProtocolCryptoAdapter } from '@web_of_trust/core'
import { ProfileStore, type StoredProfile } from './profile-store.js'
import { extractJwsPayload } from './jws-verify.js'
import { getProfilesDashboardHtml } from './dashboard-html.js'

const {
  decideProfileResourcePutAcceptance,
  verifyProfileServiceResourceJws,
  createDidKeyResolver,
} = protocol

type ProfileResourceKind = 'profile' | 'verifications' | 'attestations'

export interface ProfileServerOptions {
  port: number
  dbPath?: string
}

export class ProfileServer {
  private server: Server | null = null
  private boundPort: number | null = null
  private store: ProfileStore
  // Deterministic did:key resolver + crypto for the canonical protocol-level
  // resource verification (review MAJOR 1). did:key documents are derived purely
  // from the DID, so no network resolution or per-DID configuration is needed.
  private readonly didResolver = createDidKeyResolver()
  private readonly crypto = new WebCryptoProtocolCryptoAdapter()

  constructor(private options: ProfileServerOptions) {
    this.store = new ProfileStore(options.dbPath ?? ':memory:')
  }

  /**
   * The actual bound TCP port, resolved after {@link start}. Supports `port: 0`
   * (OS-assigned free port) — tests use this to avoid hardcoded-port collisions with
   * other packages' servers running concurrently under turbo.
   */
  get port(): number {
    return this.boundPort ?? this.options.port
  }

  async start(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.server = createServer((req, res) => this.handleRequest(req, res))
      // Surface listen failures (e.g. EADDRINUSE) as a rejected start() instead of an
      // unhandled 'error' event that vitest flags as a false-positive risk.
      this.server.once('error', reject)
      this.server.listen(this.options.port, () => {
        const addr = this.server!.address()
        this.boundPort = typeof addr === 'object' && addr !== null ? addr.port : this.options.port
        resolve()
      })
    })
  }

  async stop(): Promise<void> {
    if (this.server) {
      await new Promise<void>((resolve) => {
        this.server!.close(() => resolve())
      })
      this.server = null
    }
    this.store.close()
  }

  private async handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    // CORS headers
    res.setHeader('Access-Control-Allow-Origin', '*')
    res.setHeader('Access-Control-Allow-Methods', 'GET, PUT, OPTIONS')
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type')

    if (req.method === 'OPTIONS') {
      res.writeHead(204)
      res.end()
      return
    }

    const url = new URL(req.url ?? '/', `http://localhost:${this.port}`)

    // Batch summary endpoint: GET /s?dids=did1,did2,...
    if (url.pathname === '/s' && req.method === 'GET') {
      await this.handleSummaries(url, res)
      return
    }

    // Dashboard
    if (url.pathname === '/dashboard' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      res.end(getProfilesDashboardHtml())
      return
    }
    if (url.pathname === '/dashboard/data' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(this.store.getStats()))
      return
    }

    // Health check
    if (url.pathname === '/health' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ status: 'ok' }))
      return
    }

    const match = url.pathname.match(/^\/p\/([^/]+)(\/[va])?$/)

    if (!match) {
      res.writeHead(404)
      res.end('Not Found')
      return
    }

    const did = decodeURIComponent(match[1])
    const subResource = match[2] as '/v' | '/a' | undefined

    if (req.method === 'GET') {
      await this.handleGet(did, subResource, res)
    } else if (req.method === 'PUT') {
      await this.handlePut(did, subResource, req, res)
    } else {
      res.writeHead(405)
      res.end('Method Not Allowed')
    }
  }

  private async handleSummaries(url: URL, res: ServerResponse): Promise<void> {
    const didsParam = url.searchParams.get('dids')
    if (!didsParam) {
      res.writeHead(400, { 'Content-Type': 'text/plain' })
      res.end('Missing dids parameter')
      return
    }

    const dids = didsParam.split(',').map(d => decodeURIComponent(d.trim())).filter(Boolean)
    if (dids.length === 0) {
      res.writeHead(400, { 'Content-Type': 'text/plain' })
      res.end('Empty dids parameter')
      return
    }

    if (dids.length > 100) {
      res.writeHead(400, { 'Content-Type': 'text/plain' })
      res.end('Too many DIDs (max 100)')
      return
    }

    const summaries = this.store.getSummaries(dids)
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(summaries))
  }

  private async handleGet(did: string, subResource: '/v' | '/a' | undefined, res: ServerResponse): Promise<void> {
    let stored
    if (subResource === '/v') {
      stored = this.store.getVerifications(did)
    } else if (subResource === '/a') {
      stored = this.store.getAttestations(did)
    } else {
      stored = this.store.get(did)
    }

    if (!stored) {
      res.writeHead(404)
      res.end('Not Found')
      return
    }

    res.writeHead(200, { 'Content-Type': 'application/jws' })
    res.end(stored.jws)
  }

  private async handlePut(
    did: string,
    subResource: '/v' | '/a' | undefined,
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    // Read body
    const body = await this.readBody(req)
    if (!body) {
      res.writeHead(400)
      res.end('Empty body')
      return
    }

    // Early DID/path consistency check so a payload DID that does not match the
    // URL DID is reported as 403 (Sync 004 Z.162) rather than a generic 400.
    // The full canonical verification below re-checks this and everything else.
    const previewPayload = extractJwsPayload(body)
    if (previewPayload && typeof previewPayload.did === 'string' && previewPayload.did !== did) {
      res.writeHead(403)
      res.end('DID mismatch: payload DID does not match URL DID')
      return
    }

    // Canonical protocol-level verification (review MAJOR 1 + server minors).
    // `verifyProfileServiceResourceJws` enforces, in one place:
    //   - EdDSA alg whitelist + mandatory kid (Identity 002)
    //   - the full resource schema: mandatory non-negative INTEGER `version`
    //     (Sync 004 Z.142), exactly-one-of verifications/attestations for list
    //     resources, no didDocument/profile in list resources, profile.name for
    //     the profile resource
    //   - header kid ↔ payload DID binding (Sync 004 Z.161)
    //   - resource-path ↔ payload-field consistency (resourceKind)
    //   - signature against the DID-derived key
    // A missing / string / negative / fractional `version`, a wrong-shaped
    // payload, or a kid/DID mismatch all throw here → 400 (Sync 004 Z.196),
    // BEFORE anything is stored. This removes the previous `version === undefined`
    // opt-out that allowed a version-less PUT (and thus downgrade replays) to win.
    const resourceKind = this.resourceKind(subResource)
    let payload: { version: number }
    try {
      payload = await verifyProfileServiceResourceJws(body, {
        expectedDid: did,
        resourceKind,
        didResolver: this.didResolver,
        crypto: this.crypto,
      })
    } catch (error) {
      res.writeHead(400)
      res.end(`Invalid profile resource: ${error instanceof Error ? error.message : 'verification failed'}`)
      return
    }

    // Version monotonicity (VE-4, Sync 004 Z.155-164 MUSS) — applied to ALL three
    // routes via the protocol pure function `decideProfileResourcePutAcceptance`
    // (no duplication). `version` is now a guaranteed non-negative integer, so the
    // monotonicity check runs UNCONDITIONALLY whenever a stored baseline exists.
    // The baseline is the version column or, for legacy rows, the version read
    // lazily from the stored JWS (VE-4 Schärfung). A non-strictly-greater PUT is
    // rejected with 409 + the current stored version in the body.
    const incomingVersion = payload.version
    const stored = this.getStored(did, subResource)
    const storedVersion = stored ? this.store.storedVersion(stored) : undefined
    const decision = decideProfileResourcePutAcceptance({ incomingVersion, storedVersion })
    if (!decision.accept) {
      res.writeHead(409, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: 'version conflict', version: decision.conflictVersion }))
      return
    }

    // Store in the appropriate table (persist the version column for lazy backfill)
    if (subResource === '/v') {
      this.store.putVerifications(did, body, incomingVersion)
    } else if (subResource === '/a') {
      this.store.putAttestations(did, body, incomingVersion)
    } else {
      this.store.put(did, body, incomingVersion)
    }

    res.writeHead(200)
    res.end('OK')
  }

  private resourceKind(subResource: '/v' | '/a' | undefined): ProfileResourceKind {
    if (subResource === '/v') return 'verifications'
    if (subResource === '/a') return 'attestations'
    return 'profile'
  }

  private getStored(did: string, subResource: '/v' | '/a' | undefined): StoredProfile | null {
    if (subResource === '/v') return this.store.getVerifications(did)
    if (subResource === '/a') return this.store.getAttestations(did)
    return this.store.get(did)
  }

  private readBody(req: IncomingMessage): Promise<string> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = []
      req.on('data', (chunk) => chunks.push(chunk))
      req.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')))
      req.on('error', reject)
    })
  }
}
