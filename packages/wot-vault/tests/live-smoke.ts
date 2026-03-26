/**
 * Live smoke test for wot-vault deployed at vault.utopia-lab.org
 *
 * Usage:
 *   cd packages/wot-vault
 *   npx tsx tests/live-smoke.ts [url]
 *
 * Default URL: https://vault.utopia-lab.org
 */

import { WotIdentity, createCapability } from '@web.of.trust/core'

const VAULT_URL = process.argv[2] ?? 'https://vault.utopia-lab.org'
const DOC_ID = `smoke-test-${Date.now()}`

let passed = 0
let failed = 0

function ok(name: string) {
  passed++
  console.log(`  ✓ ${name}`)
}

function fail(name: string, detail: string) {
  failed++
  console.log(`  ✗ ${name}: ${detail}`)
}

async function createAuth(identity: WotIdentity, docId: string, permissions: string[]) {
  const token = await identity.signJws({
    did: identity.getDid(),
    iat: Math.floor(Date.now() / 1000),
  })

  const signFn = (payload: unknown) => identity.signJws(payload)
  const expiration = new Date(Date.now() + 60 * 60 * 1000).toISOString()
  const resource = `wot:space:${docId}` as any

  const capability = await createCapability(
    {
      issuer: identity.getDid(),
      audience: identity.getDid(),
      resource,
      permissions: permissions as any[],
      expiration,
    },
    signFn,
  )

  return {
    headers: {
      Authorization: `Bearer ${token}`,
      'X-Capability': capability,
      'Content-Type': 'application/json',
    },
  }
}

async function run() {
  console.log(`\nWoT Vault Live Smoke Test`)
  console.log(`URL: ${VAULT_URL}\n`)

  // Create test identity
  const alice = new WotIdentity()
  await alice.create('smoke-test', false)
  console.log(`Identity: ${alice.getDid().slice(0, 30)}...`)
  console.log(`Doc ID:   ${DOC_ID}\n`)

  // 1. Health check
  console.log('--- Health ---')
  try {
    const res = await fetch(`${VAULT_URL}/health`)
    const body = await res.json()
    if (res.status === 200 && body.status === 'ok') {
      ok('GET /health → 200 {"status":"ok"}')
    } else {
      fail('GET /health', `${res.status} ${JSON.stringify(body)}`)
    }
  } catch (e: any) {
    fail('GET /health', e.message)
  }

  // 2. 404 for unknown routes
  console.log('\n--- Routing ---')
  try {
    const res = await fetch(`${VAULT_URL}/unknown`)
    if (res.status === 404) {
      ok('GET /unknown → 404')
    } else {
      fail('GET /unknown', `expected 404, got ${res.status}`)
    }
  } catch (e: any) {
    fail('GET /unknown', e.message)
  }

  // 3. 401 without auth
  console.log('\n--- Auth ---')
  try {
    const res = await fetch(`${VAULT_URL}/docs/${DOC_ID}/info`)
    if (res.status === 401) {
      ok('GET /docs/{id}/info without auth → 401')
    } else {
      fail('GET /docs/{id}/info without auth', `expected 401, got ${res.status}`)
    }
  } catch (e: any) {
    fail('Auth check', e.message)
  }

  // 4. POST a change (write)
  console.log('\n--- Write ---')
  const auth = await createAuth(alice, DOC_ID, ['read', 'write', 'delete'])
  try {
    const changeData = Buffer.from('encrypted-change-data-1').toString('base64')
    const res = await fetch(`${VAULT_URL}/docs/${DOC_ID}/changes`, {
      method: 'POST',
      headers: auth.headers,
      body: Buffer.from('encrypted-change-data-1'),
    })
    const body = await res.json()
    if (res.status === 201 && body.seq === 1) {
      ok(`POST /docs/{id}/changes → 201 (seq=${body.seq})`)
    } else {
      fail('POST change', `${res.status} ${JSON.stringify(body)}`)
    }
  } catch (e: any) {
    fail('POST change', e.message)
  }

  // 5. POST a second change
  try {
    const res = await fetch(`${VAULT_URL}/docs/${DOC_ID}/changes`, {
      method: 'POST',
      headers: auth.headers,
      body: Buffer.from('encrypted-change-data-2'),
    })
    const body = await res.json()
    if (res.status === 201 && body.seq === 2) {
      ok(`POST second change → 201 (seq=${body.seq})`)
    } else {
      fail('POST second change', `${res.status} ${JSON.stringify(body)}`)
    }
  } catch (e: any) {
    fail('POST second change', e.message)
  }

  // 6. GET changes
  console.log('\n--- Read ---')
  try {
    const res = await fetch(`${VAULT_URL}/docs/${DOC_ID}/changes`, {
      headers: auth.headers,
    })
    const body = await res.json()
    if (res.status === 200 && body.changes?.length === 2) {
      ok(`GET /docs/{id}/changes → 200 (${body.changes.length} changes)`)
    } else {
      fail('GET changes', `${res.status} ${JSON.stringify(body)}`)
    }
  } catch (e: any) {
    fail('GET changes', e.message)
  }

  // 7. GET changes with since=1
  try {
    const res = await fetch(`${VAULT_URL}/docs/${DOC_ID}/changes?since=1`, {
      headers: auth.headers,
    })
    const body = await res.json()
    if (res.status === 200 && body.changes?.length === 1 && body.changes[0].seq === 2) {
      ok(`GET /docs/{id}/changes?since=1 → 200 (1 change, seq=2)`)
    } else {
      fail('GET changes?since=1', `${res.status} ${JSON.stringify(body)}`)
    }
  } catch (e: any) {
    fail('GET changes?since=1', e.message)
  }

  // 8. GET info
  try {
    const res = await fetch(`${VAULT_URL}/docs/${DOC_ID}/info`, {
      headers: auth.headers,
    })
    const body = await res.json()
    if (res.status === 200 && body.changeCount === 2 && body.latestSeq === 2) {
      ok(`GET /docs/{id}/info → 200 (changeCount=${body.changeCount}, latestSeq=${body.latestSeq})`)
    } else {
      fail('GET info', `${res.status} ${JSON.stringify(body)}`)
    }
  } catch (e: any) {
    fail('GET info', e.message)
  }

  // 9. PUT snapshot
  console.log('\n--- Snapshot ---')
  try {
    const res = await fetch(`${VAULT_URL}/docs/${DOC_ID}/snapshot`, {
      method: 'PUT',
      headers: auth.headers,
      body: JSON.stringify({
        data: Buffer.from('compacted-snapshot').toString('base64'),
        upToSeq: 2,
      }),
    })
    const body = await res.json()
    if (res.status === 200 && body.upToSeq === 2) {
      ok(`PUT /docs/{id}/snapshot → 200 (upToSeq=${body.upToSeq})`)
    } else {
      fail('PUT snapshot', `${res.status} ${JSON.stringify(body)}`)
    }
  } catch (e: any) {
    fail('PUT snapshot', e.message)
  }

  // 10. DELETE doc (cleanup)
  console.log('\n--- Cleanup ---')
  try {
    const res = await fetch(`${VAULT_URL}/docs/${DOC_ID}`, {
      method: 'DELETE',
      headers: auth.headers,
    })
    const body = await res.json()
    if (res.status === 200 && body.deleted === true) {
      ok(`DELETE /docs/{id} → 200 (deleted)`)
    } else {
      fail('DELETE doc', `${res.status} ${JSON.stringify(body)}`)
    }
  } catch (e: any) {
    fail('DELETE doc', e.message)
  }

  // 11. Verify deletion
  try {
    const res = await fetch(`${VAULT_URL}/docs/${DOC_ID}/info`, {
      headers: auth.headers,
    })
    if (res.status === 404) {
      ok('GET deleted doc → 404')
    } else {
      fail('Verify deletion', `expected 404, got ${res.status}`)
    }
  } catch (e: any) {
    fail('Verify deletion', e.message)
  }

  // Summary
  console.log(`\n${'─'.repeat(40)}`)
  console.log(`${passed} passed, ${failed} failed`)
  if (failed > 0) process.exit(1)
}

run().catch((e) => {
  console.error('Fatal:', e)
  process.exit(1)
})
