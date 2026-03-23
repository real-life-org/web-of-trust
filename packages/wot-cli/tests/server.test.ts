import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { createWotServer } from '../src/server.js'
import type { WotCliClient } from '../src/WotCliClient.js'

const AUTH_TOKEN = 'test-secret-token-2026'
// Random port to avoid EADDRINUSE in CI (parallel test runs)
const PORT = 10000 + Math.floor(Math.random() * 50000)

// Mock WotCliClient — simulates the real client without needing a relay/seed
function createMockClient() {
  const contacts = [
    { did: 'did:key:alice', name: 'Alice', verified: true },
    { did: 'did:key:bob', name: 'Bob', verified: false },
  ]
  const spaces = [
    { id: 'space-1', name: 'Projekt WoT', members: ['did:key:eli', 'did:key:alice'] },
  ]
  const spaceItems: Record<string, Record<string, any>> = {
    'space-1': {
      'task-1': { title: 'CLI Connector bauen', status: 'in-progress' },
      'task-2': { title: 'MCP Tools', status: 'todo' },
    },
  }
  let profilePublished = false

  return {
    getDid: () => 'did:key:z6Mkeli123',
    getProfile: async () => ({ did: 'did:key:z6Mkeli123', profile: { name: 'Eli', bio: 'WoT AI Teammate' } }),
    getContacts: async () => contacts,
    getSpaces: () => spaces,
    getSpaceItems: async (spaceId: string) => spaceItems[spaceId] ?? {},
    createSpaceItem: async (spaceId: string, itemId: string, data: any) => {
      if (!spaceItems[spaceId]) spaceItems[spaceId] = {}
      spaceItems[spaceId][itemId] = data
    },
    updateSpaceItem: async (spaceId: string, itemId: string, updates: any) => {
      if (spaceItems[spaceId]?.[itemId]) {
        Object.assign(spaceItems[spaceId][itemId], updates)
      }
    },
    sendMessage: async () => {},
    publishProfile: async () => { profilePublished = true },
    wasProfilePublished: () => profilePublished,
  } as unknown as WotCliClient & { wasProfilePublished: () => boolean }
}

async function request(path: string, options: RequestInit = {}) {
  return fetch(`http://127.0.0.1:${PORT}${path}`, {
    ...options,
    headers: {
      'Authorization': `Bearer ${AUTH_TOKEN}`,
      'Content-Type': 'application/json',
      ...options.headers,
    },
  })
}

async function requestNoAuth(path: string) {
  return fetch(`http://127.0.0.1:${PORT}${path}`)
}

describe('WoT CLI HTTP Server', () => {
  const mockClient = createMockClient()
  let server: Awaited<ReturnType<typeof createWotServer>>

  beforeAll(async () => {
    server = createWotServer({ port: PORT, authToken: AUTH_TOKEN, client: mockClient })
    await server.start()
  })

  afterAll(async () => {
    await server.stop()
  })

  // --- Auth ---

  describe('Authentication', () => {
    it('returns 401 without token', async () => {
      const res = await requestNoAuth('/profile')
      expect(res.status).toBe(401)
    })

    it('returns 401 with wrong token', async () => {
      const res = await fetch(`http://127.0.0.1:${PORT}/profile`, {
        headers: { 'Authorization': 'Bearer wrong-token' },
      })
      expect(res.status).toBe(401)
    })

    it('returns 200 with correct token', async () => {
      const res = await request('/profile')
      expect(res.status).toBe(200)
    })
  })

  // --- Health ---

  describe('Health', () => {
    it('returns ok without auth and without leaking DID', async () => {
      const res = await requestNoAuth('/health')
      expect(res.status).toBe(200)
      const data = await res.json()
      expect(data.status).toBe('ok')
      expect(data.did).toBeUndefined()
    })
  })

  // --- Profile ---

  describe('Profile', () => {
    it('GET /profile returns identity', async () => {
      const res = await request('/profile')
      const data = await res.json()
      expect(data.profile.name).toBe('Eli')
    })

    it('POST /profile/publish publishes profile', async () => {
      const res = await request('/profile/publish', { method: 'POST' })
      expect(res.status).toBe(200)
      expect((mockClient as any).wasProfilePublished()).toBe(true)
    })
  })

  // --- Contacts ---

  describe('Contacts', () => {
    it('GET /contacts returns all contacts', async () => {
      const res = await request('/contacts')
      const data = await res.json()
      expect(data).toHaveLength(2)
      expect(data[0].name).toBe('Alice')
    })
  })

  // --- Spaces ---

  describe('Spaces', () => {
    it('GET /spaces returns all spaces', async () => {
      const res = await request('/spaces')
      const data = await res.json()
      expect(data).toHaveLength(1)
      expect(data[0].name).toBe('Projekt WoT')
    })

    it('GET /spaces/:id/items returns space items', async () => {
      const res = await request('/spaces/space-1/items')
      const data = await res.json()
      expect(data['task-1'].title).toBe('CLI Connector bauen')
      expect(data['task-2'].status).toBe('todo')
    })

    it('GET /spaces/:id/items returns empty for unknown space', async () => {
      const res = await request('/spaces/nonexistent/items')
      const data = await res.json()
      expect(data).toEqual({})
    })

    it('POST /spaces/:id/items creates an item', async () => {
      const res = await request('/spaces/space-1/items', {
        method: 'POST',
        body: JSON.stringify({ id: 'task-3', data: { title: 'Neuer Task', status: 'todo' } }),
      })
      expect(res.status).toBe(201)
      const data = await res.json()
      expect(data.id).toBe('task-3')

      // Verify it was created
      const items = await request('/spaces/space-1/items')
      const itemsData = await items.json()
      expect(itemsData['task-3'].title).toBe('Neuer Task')
    })

    it('POST /spaces/:id/items generates ID if not provided', async () => {
      const res = await request('/spaces/space-1/items', {
        method: 'POST',
        body: JSON.stringify({ data: { title: 'Auto-ID Task' } }),
      })
      expect(res.status).toBe(201)
      const data = await res.json()
      expect(data.id).toBeTruthy()
    })

    it('PUT /spaces/:id/items/:itemId updates an item', async () => {
      const res = await request('/spaces/space-1/items/task-1', {
        method: 'PUT',
        body: JSON.stringify({ status: 'done' }),
      })
      expect(res.status).toBe(200)

      // Verify update
      const items = await request('/spaces/space-1/items')
      const data = await items.json()
      expect(data['task-1'].status).toBe('done')
      expect(data['task-1'].title).toBe('CLI Connector bauen') // unchanged
    })
  })

  // --- Messages ---

  describe('Messages', () => {
    it('POST /messages sends a message', async () => {
      const res = await request('/messages', {
        method: 'POST',
        body: JSON.stringify({ toDid: 'did:key:alice', type: 'profile-update', payload: {} }),
      })
      expect(res.status).toBe(200)
    })

    it('POST /messages rejects missing fields', async () => {
      const res = await request('/messages', {
        method: 'POST',
        body: JSON.stringify({ payload: {} }),
      })
      expect(res.status).toBe(400)
    })
  })

  // --- 404 ---

  describe('Not Found', () => {
    it('returns 404 for unknown routes', async () => {
      const res = await request('/unknown')
      expect(res.status).toBe(404)
    })
  })
})
