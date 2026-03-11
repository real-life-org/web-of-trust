import { VaultServer } from './server.js'

const PORT = parseInt(process.env.PORT ?? '8789', 10)
const DB_PATH = process.env.DB_PATH ?? './vault.db'

const server = new VaultServer({ port: PORT, dbPath: DB_PATH })

await server.start()
console.log(`WoT Vault running on http://localhost:${PORT}`)
console.log(`SQLite store: ${DB_PATH}`)

process.on('SIGINT', async () => {
  console.log('\nShutting down...')
  await server.stop()
  process.exit(0)
})
