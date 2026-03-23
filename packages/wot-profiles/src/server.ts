import { createServer, type IncomingMessage, type ServerResponse, type Server } from 'node:http'
import { ProfileStore } from './profile-store.js'
import { verifyProfileJws, extractJwsPayload } from './jws-verify.js'
import { getProfilesDashboardHtml } from './dashboard-html.js'

export interface ProfileServerOptions {
  port: number
  dbPath?: string
}

export class ProfileServer {
  private server: Server | null = null
  private store: ProfileStore

  constructor(private options: ProfileServerOptions) {
    this.store = new ProfileStore(options.dbPath ?? ':memory:')
  }

  async start(): Promise<void> {
    return new Promise((resolve) => {
      this.server = createServer((req, res) => this.handleRequest(req, res))
      this.server.listen(this.options.port, () => resolve())
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

    const url = new URL(req.url ?? '/', `http://localhost:${this.options.port}`)

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

    // Extract payload to check DID match
    const payload = extractJwsPayload(body)
    if (!payload || !payload.did) {
      res.writeHead(400)
      res.end('Invalid JWS or missing DID in payload')
      return
    }

    // Check DID in URL matches DID in payload
    if (payload.did !== did) {
      res.writeHead(403)
      res.end('DID mismatch: payload DID does not match URL DID')
      return
    }

    // Verify JWS signature
    const result = await verifyProfileJws(body)
    if (!result.valid) {
      res.writeHead(400)
      res.end(`Invalid JWS: ${result.error}`)
      return
    }

    // Store in the appropriate table
    if (subResource === '/v') {
      this.store.putVerifications(did, body)
    } else if (subResource === '/a') {
      this.store.putAttestations(did, body)
    } else {
      this.store.put(did, body)
    }

    res.writeHead(200)
    res.end('OK')
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
