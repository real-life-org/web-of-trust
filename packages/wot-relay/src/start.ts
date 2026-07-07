import { RelayServer } from './relay.js'

const PORT = parseInt(process.env.PORT ?? '8787', 10)
const DB_PATH = process.env.DB_PATH ?? './relay-queue.db'
// Sensitive extended /dashboard/data stats (admin DIDs, per-device counts). OFF unless
// explicitly enabled — /dashboard/data is unauthenticated + public, so prod stays redacted.
// Set this ONLY on staging / local test relays (the D1 Spur-C remote-e2e harness needs it).
const EXPOSE_DEBUG_STATS = /^(1|true|yes)$/i.test(process.env.RELAY_DEBUG_STATS ?? '')

const server = new RelayServer({ port: PORT, dbPath: DB_PATH, exposeDebugStats: EXPOSE_DEBUG_STATS })

await server.start()
console.log(`WoT Relay running on ws://localhost:${PORT}`)
console.log(`Dashboard: http://localhost:${PORT}/dashboard`)
console.log(`SQLite queue: ${DB_PATH}`)
if (EXPOSE_DEBUG_STATS) {
  console.warn('[relay] RELAY_DEBUG_STATS enabled — /dashboard/data exposes admin DIDs + per-device counts. Use only on staging/test relays.')
}

let shuttingDown = false
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return
  shuttingDown = true
  console.log(`\n${signal} received, shutting down...`)
  await server.stop()
  process.exit(0)
}

// SIGINT (Ctrl-C) and SIGTERM (Docker stop / orchestrator default) both trigger
// a clean shutdown. Without SIGTERM the container would be killed without
// stop()/db.close() (WAL-committed data still survives, but no clean teardown).
process.on('SIGINT', () => void shutdown('SIGINT'))
process.on('SIGTERM', () => void shutdown('SIGTERM'))

// Defense in depth for a durable source of truth: a stray unhandled rejection
// must not terminate the relay (Node 22 default). Handlers already report their
// own errors (handleMessage try/catch + the log-entry dispatch .catch); this
// only logs anything that still slips through instead of crashing the server.
process.on('unhandledRejection', (reason) => {
  console.error('[relay] unhandledRejection:', reason)
})
