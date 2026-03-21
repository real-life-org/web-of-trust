/**
 * WoT CLI HTTP Server — REST API for the headless WoT client.
 *
 * Runs on localhost only. All requests require Bearer token auth.
 * Used by the Eli MCP server to access WoT functionality.
 *
 * Endpoints:
 *   GET    /profile              → Eli's own profile
 *   GET    /contacts             → All contacts
 *   GET    /spaces               → All spaces
 *   GET    /spaces/:id/items     → Items in a space
 *   POST   /spaces/:id/items     → Create item in space
 *   PUT    /spaces/:id/items/:itemId → Update item
 *   DELETE /spaces/:id/items/:itemId → Delete item
 *   POST   /messages             → Send a message
 *   POST   /profile/publish      → Publish profile to discovery
 *   GET    /health               → Health check (no auth)
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { WotCliClient } from './WotCliClient.js'

export interface WotServerOptions {
  port: number
  host?: string
  authToken: string
  client: WotCliClient
}

export function createWotServer(options: WotServerOptions) {
  const { client, authToken, port, host = '127.0.0.1' } = options

  function checkAuth(req: IncomingMessage): boolean {
    const header = req.headers.authorization
    return header === `Bearer ${authToken}`
  }

  function json(res: ServerResponse, data: unknown, status = 200) {
    res.writeHead(status, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(data))
  }

  function error(res: ServerResponse, message: string, status = 400) {
    json(res, { error: message }, status)
  }

  const MAX_BODY_SIZE = 1024 * 1024 // 1 MB

  async function readBody(req: IncomingMessage): Promise<string> {
    const chunks: Buffer[] = []
    let totalSize = 0
    for await (const chunk of req) {
      totalSize += (chunk as Buffer).length
      if (totalSize > MAX_BODY_SIZE) throw new Error('Request body too large')
      chunks.push(chunk as Buffer)
    }
    return Buffer.concat(chunks).toString('utf-8')
  }

  function parseUrl(url: string): { path: string[]; query: Record<string, string> } {
    const [pathStr, queryStr] = url.split('?')
    const path = pathStr.split('/').filter(Boolean)
    const query: Record<string, string> = {}
    if (queryStr) {
      for (const pair of queryStr.split('&')) {
        const [k, v] = pair.split('=')
        query[decodeURIComponent(k)] = decodeURIComponent(v ?? '')
      }
    }
    return { path, query }
  }

  const server = createServer(async (req, res) => {
    const method = req.method ?? 'GET'
    const { path } = parseUrl(req.url ?? '/')

    // Health check — no auth required, no identity info
    if (path[0] === 'health') {
      return json(res, { status: 'ok' })
    }

    // All other endpoints require auth
    if (!checkAuth(req)) {
      return error(res, 'Unauthorized', 401)
    }

    try {
      // GET /profile
      if (method === 'GET' && path[0] === 'profile' && path.length === 1) {
        const profile = await client.getProfile()
        return json(res, profile)
      }

      // POST /profile/publish
      if (method === 'POST' && path[0] === 'profile' && path[1] === 'publish') {
        await client.publishProfile()
        return json(res, { ok: true })
      }

      // GET /contacts
      if (method === 'GET' && path[0] === 'contacts') {
        const contacts = await client.getContacts()
        return json(res, contacts)
      }

      // GET /spaces
      if (method === 'GET' && path[0] === 'spaces' && path.length === 1) {
        const spaces = client.getSpaces()
        return json(res, spaces)
      }

      // GET /spaces/:id/items
      if (method === 'GET' && path[0] === 'spaces' && path[2] === 'items' && path.length === 3) {
        const items = await client.getSpaceItems(path[1])
        return json(res, items)
      }

      // POST /spaces/:id/items
      if (method === 'POST' && path[0] === 'spaces' && path[2] === 'items' && path.length === 3) {
        const body = JSON.parse(await readBody(req))
        const itemId = body.id ?? crypto.randomUUID()
        await client.createSpaceItem(path[1], itemId, body.data ?? body)
        return json(res, { id: itemId, ok: true }, 201)
      }

      // PUT /spaces/:id/items/:itemId
      if (method === 'PUT' && path[0] === 'spaces' && path[2] === 'items' && path.length === 4) {
        const body = JSON.parse(await readBody(req))
        await client.updateSpaceItem(path[1], path[3], body)
        return json(res, { ok: true })
      }

      // DELETE /spaces/:id/items/:itemId
      if (method === 'DELETE' && path[0] === 'spaces' && path[2] === 'items' && path.length === 4) {
        await client.updateSpaceItem(path[1], path[3], { _deleted: true })
        return json(res, { ok: true })
      }

      // POST /verify/challenge — create a verification challenge
      if (method === 'POST' && path[0] === 'verify' && path[1] === 'challenge') {
        const result = await client.createChallenge()
        return json(res, result)
      }

      // POST /verify/respond — respond to someone's challenge code
      if (method === 'POST' && path[0] === 'verify' && path[1] === 'respond') {
        const body = JSON.parse(await readBody(req))
        if (!body.challengeCode) {
          return error(res, 'challengeCode required')
        }
        const result = await client.respondToChallenge(body.challengeCode)
        return json(res, result)
      }

      // POST /messages
      if (method === 'POST' && path[0] === 'messages') {
        const body = JSON.parse(await readBody(req))
        if (!body.toDid || !body.type) {
          return error(res, 'toDid and type required')
        }
        await client.sendMessage(body.toDid, body.type, body.payload ?? {})
        return json(res, { ok: true })
      }

      error(res, 'Not found', 404)
    } catch (err: any) {
      console.error('[wot-server]', err)
      error(res, err.message ?? 'Internal error', 500)
    }
  })

  return {
    start: () => new Promise<void>((resolve) => {
      server.listen(port, host, () => {
        console.log(`[wot-server] Listening on http://${host}:${port}`)
        resolve()
      })
    }),
    stop: () => new Promise<void>((resolve) => {
      server.close(() => resolve())
    }),
    server,
  }
}
