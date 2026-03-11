import { createServer, type IncomingMessage, type ServerResponse } from 'http'
import type { Server } from 'http'
import { DocStore } from './store.js'
import { verifyAccess } from './auth.js'

export interface VaultServerOptions {
  port: number
  dbPath?: string
}

/**
 * VaultServer — HTTP server for encrypted Automerge doc storage.
 *
 * Endpoints:
 *   POST   /docs/{docId}/changes       — Append encrypted change
 *   GET    /docs/{docId}/changes        — Get changes (since=N query param)
 *   PUT    /docs/{docId}/snapshot       — Store compacted snapshot
 *   GET    /docs/{docId}/info           — Get document metadata
 *   DELETE /docs/{docId}                — Delete document
 *
 * All data is opaque encrypted blobs. The server never decrypts.
 * Auth via Authorization (identity JWS) + X-Capability (signed capability).
 */
export class VaultServer {
  private server: Server | null = null
  private store: DocStore
  private options: VaultServerOptions

  constructor(options: VaultServerOptions) {
    this.options = options
    this.store = new DocStore(options.dbPath)
  }

  async start(): Promise<void> {
    return new Promise((resolve) => {
      this.server = createServer((req, res) => {
        this.handleRequest(req, res).catch((err) => {
          console.error('[vault] Unhandled error:', err)
          this.sendJson(res, 500, { error: 'Internal server error' })
        })
      })
      this.server.listen(this.options.port, '0.0.0.0', () => resolve())
    })
  }

  async stop(): Promise<void> {
    this.store.close()
    return new Promise((resolve) => {
      if (this.server) {
        this.server.close(() => resolve())
      } else {
        resolve()
      }
    })
  }

  private async handleRequest(
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    // CORS headers
    res.setHeader('Access-Control-Allow-Origin', '*')
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS')
    res.setHeader('Access-Control-Allow-Headers', 'Authorization, X-Capability, Content-Type')

    if (req.method === 'OPTIONS') {
      res.writeHead(204)
      res.end()
      return
    }

    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`)
    const path = url.pathname

    // Route: POST /docs/{docId}/changes
    const changesMatch = path.match(/^\/docs\/([^/]+)\/changes$/)
    if (changesMatch) {
      const docId = decodeURIComponent(changesMatch[1])
      if (req.method === 'POST') return this.handlePostChange(req, res, docId)
      if (req.method === 'GET') return this.handleGetChanges(req, res, docId, url)
      this.sendJson(res, 405, { error: 'Method not allowed' })
      return
    }

    // Route: PUT/GET /docs/{docId}/snapshot
    const snapshotMatch = path.match(/^\/docs\/([^/]+)\/snapshot$/)
    if (snapshotMatch) {
      const docId = decodeURIComponent(snapshotMatch[1])
      if (req.method === 'PUT') return this.handlePutSnapshot(req, res, docId)
      this.sendJson(res, 405, { error: 'Method not allowed' })
      return
    }

    // Route: GET /docs/{docId}/info
    const infoMatch = path.match(/^\/docs\/([^/]+)\/info$/)
    if (infoMatch) {
      const docId = decodeURIComponent(infoMatch[1])
      if (req.method === 'GET') return this.handleGetInfo(req, res, docId)
      this.sendJson(res, 405, { error: 'Method not allowed' })
      return
    }

    // Route: DELETE /docs/{docId}
    const deleteMatch = path.match(/^\/docs\/([^/]+)$/)
    if (deleteMatch) {
      const docId = decodeURIComponent(deleteMatch[1])
      if (req.method === 'DELETE') return this.handleDeleteDoc(req, res, docId)
      this.sendJson(res, 405, { error: 'Method not allowed' })
      return
    }

    // Health check
    if (path === '/health') {
      this.sendJson(res, 200, { status: 'ok' })
      return
    }

    this.sendJson(res, 404, { error: 'Not found' })
  }

  // --- Handlers ---

  private async handlePostChange(
    req: IncomingMessage,
    res: ServerResponse,
    docId: string,
  ): Promise<void> {
    const auth = await verifyAccess(req, docId, 'write')
    if (!auth.authenticated) {
      this.sendJson(res, 401, { error: auth.error })
      return
    }
    if (!auth.authorized) {
      this.sendJson(res, 403, { error: auth.error })
      return
    }

    const body = await this.readBody(req)
    if (!body || body.length === 0) {
      this.sendJson(res, 400, { error: 'Empty body' })
      return
    }

    const seq = this.store.appendChange(docId, body, auth.did!)
    this.sendJson(res, 201, { docId, seq })
  }

  private async handleGetChanges(
    req: IncomingMessage,
    res: ServerResponse,
    docId: string,
    url: URL,
  ): Promise<void> {
    const auth = await verifyAccess(req, docId, 'read')
    if (!auth.authenticated) {
      this.sendJson(res, 401, { error: auth.error })
      return
    }
    if (!auth.authorized) {
      this.sendJson(res, 403, { error: auth.error })
      return
    }

    const sinceParam = url.searchParams.get('since')
    const since = sinceParam ? parseInt(sinceParam, 10) : 0

    const result = this.store.getChanges(docId, since)

    this.sendJson(res, 200, {
      docId,
      snapshot: result.snapshot
        ? {
            data: result.snapshot.data.toString('base64'),
            upToSeq: result.snapshot.upToSeq,
          }
        : null,
      changes: result.changes.map((c) => ({
        seq: c.seq,
        data: c.data.toString('base64'),
        authorDid: c.authorDid,
        createdAt: c.createdAt,
      })),
    })
  }

  private async handlePutSnapshot(
    req: IncomingMessage,
    res: ServerResponse,
    docId: string,
  ): Promise<void> {
    const auth = await verifyAccess(req, docId, 'write')
    if (!auth.authenticated) {
      this.sendJson(res, 401, { error: auth.error })
      return
    }
    if (!auth.authorized) {
      this.sendJson(res, 403, { error: auth.error })
      return
    }

    const body = await this.readBodyJson(req)
    if (!body?.data || typeof body.upToSeq !== 'number') {
      this.sendJson(res, 400, { error: 'Missing data or upToSeq' })
      return
    }

    const data = Buffer.from(body.data as string, 'base64')
    this.store.putSnapshot(docId, data, body.upToSeq as number, auth.did!)
    this.sendJson(res, 200, { docId, upToSeq: body.upToSeq })
  }

  private async handleGetInfo(
    req: IncomingMessage,
    res: ServerResponse,
    docId: string,
  ): Promise<void> {
    const auth = await verifyAccess(req, docId, 'read')
    if (!auth.authenticated) {
      this.sendJson(res, 401, { error: auth.error })
      return
    }
    if (!auth.authorized) {
      this.sendJson(res, 403, { error: auth.error })
      return
    }

    const info = this.store.getInfo(docId)
    if (!info) {
      this.sendJson(res, 404, { error: 'Document not found' })
      return
    }

    this.sendJson(res, 200, { docId, ...info })
  }

  private async handleDeleteDoc(
    req: IncomingMessage,
    res: ServerResponse,
    docId: string,
  ): Promise<void> {
    const auth = await verifyAccess(req, docId, 'delete')
    if (!auth.authenticated) {
      this.sendJson(res, 401, { error: auth.error })
      return
    }
    if (!auth.authorized) {
      this.sendJson(res, 403, { error: auth.error })
      return
    }

    this.store.deleteDoc(docId)
    this.sendJson(res, 200, { docId, deleted: true })
  }

  // --- Helpers ---

  private sendJson(res: ServerResponse, status: number, data: unknown): void {
    res.writeHead(status, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(data))
  }

  private readBody(req: IncomingMessage): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = []
      req.on('data', (chunk: Buffer) => chunks.push(chunk))
      req.on('end', () => resolve(Buffer.concat(chunks)))
      req.on('error', reject)
    })
  }

  private async readBodyJson(req: IncomingMessage): Promise<Record<string, unknown> | null> {
    try {
      const body = await this.readBody(req)
      return JSON.parse(body.toString('utf-8'))
    } catch {
      return null
    }
  }
}
