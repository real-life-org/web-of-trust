import { spawn, type ChildProcess } from 'child_process'
import { mkdtemp, writeFile } from 'fs/promises'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import { tmpdir } from 'os'
import net from 'net'

const __dirname = dirname(fileURLToPath(import.meta.url))
const RELAY_PORT = 9787
const PROFILES_PORT = 9788
const VAULT_PORT = 9789
const STATE_FILE = '/tmp/wot-e2e-state.json'
const MONOREPO_ROOT = join(__dirname, '..', '..', '..')

interface ServerState {
  relayPid: number
  profilesPid: number
  vaultPid: number
  tmpDir: string
}

function waitForPort(port: number, timeoutMs = 10_000): Promise<void> {
  const start = Date.now()
  return new Promise((resolve, reject) => {
    function tryConnect() {
      if (Date.now() - start > timeoutMs) {
        reject(new Error(`Port ${port} not ready after ${timeoutMs}ms`))
        return
      }
      const socket = new net.Socket()
      socket.once('connect', () => {
        socket.destroy()
        resolve()
      })
      socket.once('error', () => {
        socket.destroy()
        setTimeout(tryConnect, 200)
      })
      socket.connect(port, '127.0.0.1')
    }
    tryConnect()
  })
}

function spawnServer(
  script: string,
  env: Record<string, string>,
): ChildProcess {
  const child = spawn('tsx', [script], {
    env: { ...process.env, ...env },
    cwd: MONOREPO_ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
  })

  child.stdout?.on('data', (data: Buffer) => {
    process.stdout.write(`[server] ${data}`)
  })
  child.stderr?.on('data', (data: Buffer) => {
    process.stderr.write(`[server:err] ${data}`)
  })

  return child
}

/** Kill any process listening on the given port (leftover from a previous run). */
async function killPortHolder(port: number): Promise<void> {
  try {
    const { execSync } = await import('child_process')
    const pid = execSync(`lsof -ti tcp:${port} 2>/dev/null || fuser ${port}/tcp 2>/dev/null`, {
      encoding: 'utf-8',
    }).trim()
    if (pid) {
      for (const p of pid.split('\n').filter(Boolean)) {
        try { process.kill(Number(p), 'SIGKILL') } catch { /* already gone */ }
      }
      // Give OS time to release the port
      await new Promise(r => setTimeout(r, 500))
      console.log(`[e2e] Killed stale process on port ${port} (pid ${pid})`)
    }
  } catch {
    // No process on that port — that's fine
  }
}

export default async function globalSetup() {
  // Clean up stale processes from previous runs that didn't tear down properly
  await Promise.all([
    killPortHolder(RELAY_PORT),
    killPortHolder(PROFILES_PORT),
    killPortHolder(VAULT_PORT),
  ])

  const tmpDir = await mkdtemp(join(tmpdir(), 'wot-e2e-'))

  console.log(`[e2e] Starting servers (tmp: ${tmpDir})`)

  const relay = spawnServer(
    join(MONOREPO_ROOT, 'packages/wot-relay/src/start.ts'),
    {
      PORT: String(RELAY_PORT),
      DB_PATH: join(tmpDir, 'relay.db'),
    },
  )

  const profiles = spawnServer(
    join(MONOREPO_ROOT, 'packages/wot-profiles/src/start.ts'),
    {
      PORT: String(PROFILES_PORT),
      DB_PATH: join(tmpDir, 'profiles.db'),
    },
  )

  const vault = spawnServer(
    join(MONOREPO_ROOT, 'packages/wot-vault/src/start.ts'),
    {
      PORT: String(VAULT_PORT),
      DB_PATH: join(tmpDir, 'vault.db'),
    },
  )

  // Wait for all servers to be ready
  await Promise.all([
    waitForPort(RELAY_PORT),
    waitForPort(PROFILES_PORT),
    waitForPort(VAULT_PORT),
  ])

  console.log(`[e2e] Servers ready (relay: ${RELAY_PORT}, profiles: ${PROFILES_PORT}, vault: ${VAULT_PORT})`)

  // NOTE: VITE_VAULT_URL is passed to Vite in playwright.config.ts webServer command.
  // This enables Vault-Pull for offline multi-device scenarios.

  const state: ServerState = {
    relayPid: relay.pid!,
    profilesPid: profiles.pid!,
    vaultPid: vault.pid!,
    tmpDir,
  }

  await writeFile(STATE_FILE, JSON.stringify(state))
}
