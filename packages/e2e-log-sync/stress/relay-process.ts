/**
 * Festival-Scale-Stress — Mode L relay subprocess.
 *
 * Boots the REAL relay as a SEPARATE process (`tsx packages/wot-relay/src/start.ts`)
 * with file-backed SQLite + `RELAY_DEBUG_STATS=1` — NOT the in-process `:memory:`
 * relay of the harness (which measures neither process isolation nor disk I/O). Same
 * code path as the staging container.
 *
 * Fail-fast: the relay has no EADDRINUSE retry (it crashes on a busy port). We detect
 * a child exit BEFORE the "running" log line and reject with the recent output so the
 * cause (port in use, missing tsx, build error) is visible — not a misattributed guess.
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { mkdir, open, type FileHandle } from 'node:fs/promises'
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
  const logPath = resolve(artifactsAbs, 'relay.log')
  const logFile = await open(logPath, 'a')

  // `pnpm --filter @web_of_trust/relay exec tsx` resolves tsx from the relay package
  // deterministically. A bare `pnpm exec tsx` with a repo-root cwd is hoisting-dependent
  // (tsx may not be resolvable on a fresh checkout → "tsx not found", which the exit-handler
  // would otherwise misattribute to a busy port).
  const child: ChildProcess = spawn(
    'pnpm',
    ['--filter', '@web_of_trust/relay', 'exec', 'tsx', RELAY_ENTRY],
    {
      cwd: REPO_ROOT,
      env: {
        ...process.env,
        PORT: String(opts.port),
        DB_PATH: dbPathAbs,
        RELAY_DEBUG_STATS: '1',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  )

  // Kill the child if the parent process dies unexpectedly (no orphaned relay holding the port).
  const killOnParentExit = () => {
    try {
      child.kill('SIGKILL')
    } catch {
      /* already gone */
    }
  }
  process.once('exit', killOnParentExit)

  const closeLog = (fh: FileHandle) => {
    void fh.close().catch(() => {})
  }

  return await new Promise<RelayProcess>((resolvePromise, reject) => {
    let settled = false
    let stopped = false
    let outputTail = '' // last chunk of combined stdout+stderr for diagnostics

    const record = (text: string) => {
      void logFile.write(text)
      outputTail = (outputTail + text).slice(-2_000)
    }

    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      process.removeListener('exit', killOnParentExit)
      child.kill('SIGKILL')
      closeLog(logFile)
      reject(new Error(`relay did not become ready within ${READY_TIMEOUT_MS}ms (marker "${READY_MARKER}" not seen). See ${logPath}.`))
    }, READY_TIMEOUT_MS)

    const onReady = () => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolvePromise({
        url: `ws://localhost:${opts.port}`,
        stop: () =>
          new Promise<void>((res) => {
            if (stopped || child.exitCode !== null || child.signalCode !== null) {
              stopped = true
              process.removeListener('exit', killOnParentExit)
              closeLog(logFile)
              return res()
            }
            stopped = true
            process.removeListener('exit', killOnParentExit)
            child.once('exit', () => {
              closeLog(logFile)
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
      record(text)
      if (outputTail.includes(READY_MARKER)) onReady()
    })
    child.stderr?.on('data', (chunk: Buffer) => record(chunk.toString()))

    child.once('exit', (code, signal) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      process.removeListener('exit', killOnParentExit)
      closeLog(logFile)
      reject(
        new Error(
          `relay exited before ready (code=${code}, signal=${signal}). Likely causes: port ${opts.port} ` +
            `in use, missing tsx, or a relay startup/build error. Recent output:\n${outputTail.trim() || '(none)'}\n` +
            `Full log: ${logPath}.`,
        ),
      )
    })
    child.once('error', (err) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      process.removeListener('exit', killOnParentExit)
      closeLog(logFile)
      reject(err)
    })
  })
}
