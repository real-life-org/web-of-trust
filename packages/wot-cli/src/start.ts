#!/usr/bin/env tsx
/**
 * WoT CLI — Start the headless WoT client with HTTP API.
 *
 * Required env vars:
 *   WOT_PASSPHRASE     — Passphrase for encrypted seed
 *   WOT_AUTH_TOKEN      — Bearer token for HTTP API auth
 *
 * Optional env vars:
 *   WOT_SEED_PATH       — Path to encrypted seed file (default: ./data/wot-identity.enc)
 *   WOT_DB_PATH         — Path to SQLite database (default: ./data/wot-cli.db)
 *   WOT_PORT            — HTTP server port (default: 8790)
 *   WOT_RELAY_URL       — Relay WebSocket URL
 *   WOT_PROFILE_URL     — Profile discovery server URL
 *   WOT_VAULT_URL       — Vault server URL
 */

// Polyfill WebSocket for Node.js < 22
import WebSocket from 'ws'
if (typeof globalThis.WebSocket === 'undefined') {
  ;(globalThis as any).WebSocket = WebSocket
}

import { WotCliClient } from './WotCliClient.js'
import { createWotServer } from './server.js'

const passphrase = process.env.WOT_PASSPHRASE
const authToken = process.env.WOT_AUTH_TOKEN

if (!passphrase || !authToken) {
  console.error('Required environment variables:')
  console.error('  WOT_PASSPHRASE  — Passphrase for encrypted seed')
  console.error('  WOT_AUTH_TOKEN   — Bearer token for HTTP API auth')
  process.exit(1)
}

const client = new WotCliClient({
  seedPath: process.env.WOT_SEED_PATH ?? './data/wot-identity.enc',
  dbPath: process.env.WOT_DB_PATH ?? './data/wot-cli.db',
  relayUrl: process.env.WOT_RELAY_URL,
  profileServiceUrl: process.env.WOT_PROFILE_URL,
  vaultUrl: process.env.WOT_VAULT_URL,
})

const port = parseInt(process.env.WOT_PORT ?? '8790', 10)
const host = process.env.WOT_HOST ?? '0.0.0.0'

async function main() {
  console.log('[wot-cli] Starting...')

  await client.init(passphrase!)
  await client.connect()

  const server = createWotServer({ port, host, authToken: authToken!, client })
  await server.start()

  console.log('[wot-cli] Ready')

  // Graceful shutdown
  const shutdown = async () => {
    console.log('\n[wot-cli] Shutting down...')
    await server.stop()
    await client.disconnect()
    process.exit(0)
  }

  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
}

main().catch((err) => {
  console.error('[wot-cli] Fatal:', err)
  process.exit(1)
})
