import { readFile, rm, unlink } from 'fs/promises'

const STATE_FILE = '/tmp/wot-e2e-state.json'

export default async function globalTeardown() {
  let state: { relayPid?: number; profilesPid?: number; vaultPid?: number; tmpDir?: string; external?: boolean }

  try {
    const raw = await readFile(STATE_FILE, 'utf-8')
    state = JSON.parse(raw)
  } catch {
    console.warn('[e2e] No state file found, nothing to clean up')
    return
  }

  // External-backend mode: nothing was spawned — only drop the state file.
  if (state.external) {
    try { await unlink(STATE_FILE) } catch { /* ignore */ }
    console.log('[e2e] External backend mode — no local servers to stop')
    return
  }

  console.log('[e2e] Stopping servers...')

  // Kill server processes
  for (const pid of [state.relayPid, state.profilesPid, state.vaultPid].filter(Boolean)) {
    try {
      process.kill(pid, 'SIGTERM')
    } catch {
      // Process already exited
    }
  }

  // Clean up temp directory
  try {
    if (state.tmpDir) await rm(state.tmpDir, { recursive: true, force: true })
  } catch {
    // Ignore cleanup errors
  }

  // Remove state file
  try {
    await unlink(STATE_FILE)
  } catch {
    // Ignore
  }

  console.log('[e2e] Cleanup complete')
}
