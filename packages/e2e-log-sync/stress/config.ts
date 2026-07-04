/**
 * Festival-Scale-Stress — run configuration (env-parametrized, deterministic).
 *
 * Two topology modes:
 *  - **L (local, default):** a separate relay PROCESS (`tsx wot-relay/src/start.ts`)
 *    on `STRESS_RELAY_PORT` (default 18787) with file-backed SQLite under
 *    `stress-artifacts/<ts>/` and `RELAY_DEBUG_STATS=1`. Full scale.
 *  - **S (staging, remote):** `REMOTE_RELAY_URL` (e.g. the staging relay). Reduced
 *    scale; destructive → requires `REMOTE_ALLOW_DESTRUCTIVE` + coordination.
 *
 * Every knob has a default; `SEED` makes the RNG (and therefore the whole run)
 * reproducible.
 */

export type StressMode = 'L' | 'S'

export interface StressConfig {
  mode: StressMode
  /** WS URL clients dial. Mode L: ws://localhost:PORT. Mode S: REMOTE_RELAY_URL. */
  relayUrl: string
  /** Mode L only: the fixed port the spawned relay binds (fail-fast if busy). */
  port: number
  /** Mode L only: file-backed SQLite path for the spawned relay. */
  dbPath: string
  /** Directory for this run's artifacts (db + reports), stress-artifacts/<ts>/. */
  artifactsDir: string
  /** ISO-ish timestamp token used in artifact filenames. */
  stamp: string

  users: number
  dualDeviceUsers: number
  spaces: number
  bigSpaceMembers: number
  burstMsgsPerDevice: number
  offlineCohortPct: number
  seed: number

  /** Mode S: must be explicitly allowed (REMOTE_ALLOW_DESTRUCTIVE truthy). */
  allowDestructiveRemote: boolean
}

function intEnv(name: string, def: number): number {
  const raw = process.env[name]
  if (raw === undefined || raw.trim() === '') return def
  const n = Number.parseInt(raw, 10)
  if (!Number.isFinite(n) || n < 0) throw new Error(`env ${name} must be a non-negative integer, got ${JSON.stringify(raw)}`)
  return n
}

/** Like intEnv, but additionally bounded to 0..99 (a percentage that must leave a remainder). */
function boundedPctEnv(name: string, def: number): number {
  const n = intEnv(name, def)
  if (n > 99) throw new Error(`env ${name} must be 0..99 (an offline storm needs a non-empty ONLINE cohort), got ${n}`)
  return n
}

/** A tsx-runner-safe timestamp token (colons/dots replaced for filesystem safety). */
export function makeStamp(now: Date): string {
  return now.toISOString().replace(/[:.]/g, '-')
}

export function loadConfig(env: NodeJS.ProcessEnv, now: Date): StressConfig {
  const remoteUrl = env.REMOTE_RELAY_URL?.trim() || undefined
  const mode: StressMode = remoteUrl ? 'S' : 'L'
  const allowDestructiveRemote = /^(1|true|yes)$/i.test(env.REMOTE_ALLOW_DESTRUCTIVE ?? '')

  // Scale defaults differ per mode: mode S runs against a SHARED staging relay, so it
  // stays deliberately small (Anton coordinates); mode L is full festival scale.
  const scaleDefaults =
    mode === 'S'
      ? { users: 18, dualDeviceUsers: 2, spaces: 3, bigSpaceMembers: 8 }
      : { users: 100, dualDeviceUsers: 20, spaces: 10, bigSpaceMembers: 30 }

  const port = intEnv('STRESS_RELAY_PORT', 18787)
  const stamp = makeStamp(now)
  const artifactsDir = env.STRESS_ARTIFACTS_DIR?.trim() || `stress-artifacts/${stamp}`

  const users = intEnv('USERS', scaleDefaults.users)
  const dualDeviceUsers = Math.min(intEnv('DUAL_DEVICE_USERS', scaleDefaults.dualDeviceUsers), users)

  return {
    mode,
    relayUrl: remoteUrl ?? `ws://localhost:${port}`,
    port,
    dbPath: env.DB_PATH?.trim() || `${artifactsDir}/relay.db`,
    artifactsDir,
    stamp,
    users,
    dualDeviceUsers,
    spaces: intEnv('SPACES', scaleDefaults.spaces),
    bigSpaceMembers: intEnv('BIG_SPACE_MEMBERS', scaleDefaults.bigSpaceMembers),
    burstMsgsPerDevice: intEnv('BURST_MSGS_PER_DEVICE', 20),
    // 0..99: the offline storm NEEDS a non-empty online cohort writing during the
    // window — at 100% nobody writes and the catch-up phase silently tests nothing.
    // Fail-fast here instead of quietly running a meaningless storm.
    offlineCohortPct: boundedPctEnv('OFFLINE_COHORT_PCT', 30),
    seed: intEnv('SEED', 42),
    allowDestructiveRemote,
  }
}

/** Deterministic PRNG (mulberry32) — same SEED ⇒ identical run shape (jitter, cohort choice). */
export function makeRng(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** Deterministic integer in [0, maxExclusive). */
export function rngInt(rng: () => number, maxExclusive: number): number {
  return Math.floor(rng() * maxExclusive)
}
