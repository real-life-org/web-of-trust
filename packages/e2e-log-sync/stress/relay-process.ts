/**
 * Festival-Scale-Stress — Mode L relay subprocess.
 *
 * Boots the REAL relay as a SEPARATE process (`tsx packages/wot-relay/src/start.ts`)
 * with file-backed SQLite + `RELAY_DEBUG_STATS=1` — NOT the in-process `:memory:`
 * relay of the harness (which measures neither process isolation nor disk I/O). Same
 * code path as the staging container.
 *
 * Fail-fast: the relay has no EADDRINUSE retry (it crashes on a busy port). We detect
 * a child exit BEFORE the "running" log line and reject with a clear message.
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { mkdir, open } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const RELAY_ENTRY = fileURLToPath(new URL('../../wot-relay/src/start.ts', import.meta.url))
const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url))
const READY_MARKER = 'WoT Relay running on'
const READY_TIMEOUT_MS = 30_000

export interface RelayProcess {
  url: string
  stop(): Promise<void>
}

export interface SpawnRelayOptions {
  port: number
  dbPath: string
  artifactsDir: string
}

/** Spawn the relay and resolve once it logs the ready marker; reject on early exit. */
export async function spawnRelay(opts: SpawnRelayOptions): Promise<RelayProcess> {
  const dbPathAbs = resolve(REPO_ROOT, opts.dbPath)
  const artifactsAbs = resolve(REPO_ROOT, opts.artifactsDir)
  await mkdir(dirname(dbPathAbs), { recursive: true })
  await mkdir(artifactsAbs, { recursive: true })

  const logFile = await open(resolve(artifactsAbs, 'relay.log'), 'a')

  const child: ChildProcess = spawn('pnpm', ['exec', 'tsx', RELAY_ENTRY], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      PORT: String(opts.port),
      DB_PATH: dbPathAbs,
      RELAY_DEBUG_STATS: '1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })

  return await new Promise<RelayProcess>((resolvePromise, reject) => {
    let settled = false
    let stdoutBuf = ''

    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      child.kill('SIGKILL')
      reject(new Error(`relay did not become ready within ${READY_TIMEOUT_MS}ms (marker "${READY_MARKER}" not seen)`))
    }, READY_TIMEOUT_MS)

    const onReady = () => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolvePromise({
        url: `ws://localhost:${opts.port}`,
        stop: () =>
          new Promise<void>((res) => {
            if (child.exitCode !== null || child.signalCode !== null) {
              void logFile.close()
              return res()
            }
            child.once('exit', () => {
              void logFile.close()
              res()
            })
            child.kill('SIGTERM')
            // Hard-kill backstop if it ignores SIGTERM.
            setTimeout(() => child.kill('SIGKILL'), 3_000).unref()
          }),
      })
    }

    child.stdout?.on('data', (chunk: Buffer) => {
      const text = chunk.toString()
      void logFile.write(text)
      stdoutBuf += text
      if (stdoutBuf.includes(READY_MARKER)) onReady()
    })
    child.stderr?.on('data', (chunk: Buffer) => {
      void logFile.write(chunk.toString())
    })

    child.once('exit', (code, signal) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      void logFile.close()
      reject(
        new Error(
          `relay process exited before ready (code=${code}, signal=${signal}). ` +
            `Most likely the port ${opts.port} is already in use — the relay fail-fasts on EADDRINUSE. ` +
            `See ${resolve(artifactsAbs, 'relay.log')}.`,
        ),
      )
    })
    child.once('error', (err) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      void logFile.close()
      reject(err)
    })
  })
}
