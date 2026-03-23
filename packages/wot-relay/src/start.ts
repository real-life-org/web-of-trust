import { RelayServer } from './relay.js'

const PORT = parseInt(process.env.PORT ?? '8787', 10)
const DB_PATH = process.env.DB_PATH ?? './relay-queue.db'

const server = new RelayServer({ port: PORT, dbPath: DB_PATH })

await server.start()
console.log(`WoT Relay running on ws://localhost:${PORT}`)
console.log(`Dashboard: http://localhost:${PORT}/dashboard`)
console.log(`SQLite queue: ${DB_PATH}`)

process.on('SIGINT', async () => {
  console.log('\nShutting down...')
  await server.stop()
  process.exit(0)
})
