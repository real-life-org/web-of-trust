// Interleavings of the identity lifecycle (src/adapters/identity/LIFECYCLE.md). A scheduler sits
// between the runtime and its host, vault, biometric port and SubtleCrypto: every call becomes an
// entry the test releases. Per call a seeded generator chooses to answer at once, to hold the
// request (the effect happens at release), to hold the answer (the effect happens now, the answer
// at release), to fail once, or (one method per run) to fail from then on. A second seeded
// generator starts operations, overlapping and without awaiting them, and releases held calls in a
// random order. After every step and at the end the invariants of the contract are checked.
//
// Cells: every (method, behaviour) pair of CELLS must be hit by at least one run; the test fails
// on a cell no run visited, so a branch the generator stopped reaching is noticed, not passed.
// A failing run names its seed and the operation log; `SEED=<n>` reruns one seed alone.
import { AsyncLocalStorage } from 'node:async_hooks'
import { writeFileSync } from 'node:fs'
import { afterAll, describe, expect, it } from 'vitest'
import { createIdentityRuntime } from '../../src/adapters/identity'
import type { HolderHandle, HolderHost } from '../../src/adapters/identity/host'
import { createSimWorld, simHolderHost } from '../../src/adapters/sim'
import { fakeDevice, fakeEntropy, fakeIdentityPlatform, virtualClock } from '../../src/platform/fake'
import type { IdentityPlatform } from '../../src/platform/ports'
import type { Mnemonic, Secret } from '../../src/port'
import { secret } from '../../src/port'

// ── seeded randomness ───────────────────────────────────────────────────────

function rng(seed: number) {
  let a = seed >>> 0 || 1
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
  return {
    next,
    int: (n: number) => Math.floor(next() * n),
    pick<T>(xs: readonly T[]): T {
      return xs[Math.floor(next() * xs.length)] as T
    },
    weighted<T extends string>(w: Readonly<Record<T, number>>): T {
      const entries = Object.entries(w) as [T, number][]
      let r = next() * entries.reduce((s, [, x]) => s + x, 0)
      for (const [k, x] of entries) if ((r -= x) < 0) return k
      return entries[entries.length - 1]![0]
    },
  }
}

// ── the scheduler ───────────────────────────────────────────────────────────

type Behaviour = 'hold-request' | 'hold-answer' | 'fail' | 'fail-always'
const BEHAVIOURS: readonly Behaviour[] = ['hold-request', 'hold-answer', 'fail', 'fail-always']

/** Every await of the runtime on host, vault and biometric port that the operations below reach. */
const CELLS = {
  host: ['open', 'init', 'quiesce', 'deregister', 'seal', 'close'],
  vault: ['exists', 'head', 'open', 'init', 'bioUnusable', 'active', 'activate', 'resume', 'setResume', 'create', 'wipe', 'verifyWiped', 'namespaces', 'setProtection'],
  biometric: ['availability', 'hasEntry', 'retrieve', 'remove', 'hasLegacy', 'store'],
} as const
const CELL_METHODS = Object.entries(CELLS).flatMap(([port, ms]) => ms.map((m) => `${port}.${m}`))
const ALL_CELLS = CELL_METHODS.flatMap((m) => BEHAVIOURS.map((b) => `${m}:${b}`))
/** host methods whose permanent failure may leave an opening in closing at the end */
const HOST_CLOSE_PATH = new Set(['host.close'])

type CallState = 'ready' | 'held-request' | 'running' | 'held-answer' | 'done'
interface Call {
  readonly id: number
  readonly name: string
  state: CallState
  holdAnswer: boolean
  fail: boolean
  readonly run: () => Promise<unknown>
  outcome: { ok: true; value: unknown } | { ok: false; error: unknown } | null
  readonly resolve: (v: unknown) => void
  readonly reject: (e: unknown) => void
}

const macrotask = () => new Promise<void>((r) => setImmediate(r))

function scheduler(seed: number, focus: string) {
  const r = rng(seed * 7919 + 13)
  const calls: Call[] = []
  const visited = new Set<string>()
  let chaos = false
  let nextId = 0
  let failAlways: string | null = null
  const focusMethod = focus.slice(0, focus.lastIndexOf(':'))
  const focusBehaviour = focus.slice(focus.lastIndexOf(':') + 1) as Behaviour
  let focusUsed = false
  let calmed = false
  /** one in thirty runs also fails a random method permanently */
  const randomFailAlways = r.next() < 1 / 30 ? r.pick(CELL_METHODS) : null
  const randomFailAt = r.int(30)
  let step = 0

  const decide = (name: string): { hold: 'request' | 'answer' | null; fail: boolean } => {
    if (!CELL_METHODS.includes(name)) return { hold: null, fail: false }
    if (failAlways === name) {
      visited.add(`${name}:fail-always`)
      return { hold: null, fail: true }
    }
    if (calmed) return { hold: null, fail: false }
    let b: Behaviour | null = null
    if (!focusUsed && name === focusMethod) {
      focusUsed = true
      b = focusBehaviour
    } else if (randomFailAlways === name && step >= randomFailAt) b = 'fail-always'
    else {
      const x = r.next()
      b = x < 0.16 ? 'hold-request' : x < 0.26 ? 'hold-answer' : x < 0.3 ? 'fail' : null
    }
    if (!b) return { hold: null, fail: false }
    visited.add(`${name}:${b}`)
    if (b === 'fail-always') {
      failAlways = name
      return { hold: null, fail: true }
    }
    return { hold: b === 'hold-request' ? 'request' : b === 'hold-answer' ? 'answer' : null, fail: b === 'fail' }
  }

  const call = (name: string, run: () => Promise<unknown>): Promise<unknown> => {
    if (!chaos) return run()
    const d = decide(name)
    return new Promise((resolve, reject) => {
      calls.push({
        id: nextId++,
        name,
        state: d.hold === 'request' ? 'held-request' : 'ready',
        holdAnswer: d.hold === 'answer',
        fail: d.fail,
        run,
        outcome: null,
        resolve,
        reject,
      })
    })
  }

  const deliver = (c: Call) => {
    c.state = 'done'
    const o = c.outcome!
    if (o.ok) c.resolve(o.value)
    else c.reject(o.error)
  }

  const execute = async (c: Call) => {
    c.state = 'running'
    if (c.fail) c.outcome = { ok: false, error: new Error(`injected failure: ${c.name}`) }
    else {
      try {
        c.outcome = { ok: true, value: await c.run() }
      } catch (error) {
        c.outcome = { ok: false, error }
      }
    }
    if (c.holdAnswer) c.state = 'held-answer'
    else deliver(c)
  }

  return {
    calls,
    visited,
    get failAlways() {
      return failAlways
    },
    setStep: (n: number) => (step = n),
    start: () => (chaos = true),
    /** from here on every call answers at once, except a method that fails always */
    calm() {
      calmed = true
      for (const c of calls) c.holdAnswer = false
    },
    call,
    held: () => calls.filter((c) => c.state === 'held-request' || c.state === 'held-answer'),
    /** executes every ready call, one at a time in the order of the requests */
    async pump() {
      for (;;) {
        await macrotask()
        const c = calls.find((x) => x.state === 'ready')
        if (!c) return
        await execute(c)
      }
    },
    release(c: Call) {
      if (c.state === 'held-request') c.state = 'ready'
      else if (c.state === 'held-answer') deliver(c)
    },
    /** host.open answers that are still on their way to the runtime */
    inTransit(): HolderHandle[] {
      return calls
        .filter((c) => c.name === 'host.open' && c.state === 'held-answer' && c.outcome?.ok)
        .map((c) => (c.outcome as { value: { kind: string; holder?: HolderHandle } }).value)
        .filter((v) => v.kind === 'ok')
        .map((v) => v.holder!)
    },
  }
}

type Scheduler = ReturnType<typeof scheduler>

function wrap<T extends object>(target: T, port: string, s: Scheduler, names: readonly string[], record: (name: string, args: unknown[], out?: unknown) => void): T {
  const out: Record<string, unknown> = {}
  for (const key of Object.keys(target)) {
    const v = (target as Record<string, unknown>)[key]
    if (typeof v !== 'function') {
      out[key] = v
      continue
    }
    const fn = v.bind(target) as (...a: unknown[]) => unknown
    out[key] = names.includes(key)
      ? (...args: unknown[]) => {
          record(`${port}.${key}`, args)
          return s.call(`${port}.${key}`, async () => {
            const value = await fn(...args)
            record(`${port}.${key}`, [], value)
            return value
          })
        }
      : fn
  }
  return out as T
}

/** SubtleCrypto of the runtime through the scheduler (real crypto is the only other async source) */
function scheduledSubtle(s: Scheduler): SubtleCrypto {
  const real = globalThis.crypto.subtle
  return new Proxy(real, {
    get(t, key) {
      const v = Reflect.get(t, key, t) as unknown
      if (typeof v !== 'function') return v
      return (...args: unknown[]) => s.call(`subtle.${String(key)}`, () => (v as (...a: unknown[]) => Promise<unknown>).apply(t, args))
    },
  }) as SubtleCrypto
}

/** platform writes: none may start from an operation a lock or boot discarded */
const WRITES = new Set(['vault.setProtection', 'vault.rewrap', 'vault.setBioUnusable', 'vault.activate', 'vault.setResume', 'vault.create', 'vault.wipe', 'biometric.store', 'biometric.remove'])
/** writes whose secret argument must never be overwritten bytes */
const SECRET_WRITES = new Set(['vault.setProtection', 'vault.rewrap', 'vault.create', 'biometric.store'])
/** the operation a call was issued by (async context of the operation's body) */
const current = new AsyncLocalStorage<{ readonly name: string; preempted: boolean }>()

// ── one device under the scheduler ──────────────────────────────────────────

const PASSPHRASE = 'correct horse battery'
const NEW_PASSPHRASE = 'new passphrase'
const WORDS12 = 'awake print paper end page another thumb raccoon pond guide easily isolate'
const WORDS15 = 'before slab path face tennis argue various cotton profit marble educate learn embrace student excess'
const PROMPT = { title: '', subtitle: '', cancel: '' }
const words = (w: string) => secret(w.split(' ')) as unknown as Secret<Mnemonic>

function device(seed: number, focus: string) {
  const s = scheduler(seed, focus)
  const clock = virtualClock(Date.parse('2026-10-15T09:30:00-07:00'), 'America/Los_Angeles')
  const entropy = fakeEntropy(seed + 1)
  const d = fakeDevice()
  const world = createSimWorld({ me: { name: '', anchorShort: '' }, persons: [], contacts: [], groups: [], decisions: [], conversations: [] }, { clock, entropy })
  const host = simHolderHost(world, new Map(), d.databases, { relationships: 2 })
  /** every secret buffer the runtime handed out or received; all must be zero once nothing owns them */
  const secrets: Uint8Array[] = []
  const keep = (x: unknown) => {
    if (x instanceof Uint8Array) secrets.push(x)
    else if (x && typeof x === 'object') {
      const o = x as Record<string, unknown>
      for (const k of ['rootIkm', 'dek', 'secret']) if (o[k] instanceof Uint8Array) secrets.push(o[k] as Uint8Array)
    }
  }
  const violations: string[] = []
  const record = (name: string, args: unknown[], out?: unknown) => {
    if (args.length > 0 && WRITES.has(name)) {
      const op = current.getStore()
      if (op?.preempted && SESSION_OPS.has(op.name)) violations.push(`${name} started by ${op.name} after a lock or boot discarded it`)
      if (SECRET_WRITES.has(name))
        for (const a of args) if (a instanceof Uint8Array && a.length > 0 && a.every((x) => x === 0)) violations.push(`${name} with overwritten (zero) secret bytes`)
    }
    if (name === 'vault.open' || name === 'vault.create' || name === 'biometric.store' || name === 'host.open' || name === 'vault.setProtection') for (const a of args) keep(a)
    if (out !== undefined && (name === 'vault.open' || name === 'biometric.retrieve')) keep(out)
  }
  const plat = fakeIdentityPlatform(d, { clock, entropy })
  const platform: IdentityPlatform = {
    ...plat,
    vault: wrap(plat.vault, 'vault', s, [...CELLS.vault, 'setProtection', 'rewrap', 'setBioUnusable'], record),
    biometric: wrap(plat.biometric, 'biometric', s, [...CELLS.biometric, 'store', 'removeLegacy'], record),
  }
  const wrappedHost: HolderHost = wrap(host as HolderHost, 'host', s, [...CELLS.host, 'acceptTerms'], record)
  const runtime = createIdentityRuntime(platform, wrappedHost, { subtle: scheduledSubtle(s) })
  return { s, d, host, runtime, secrets, violations }
}

// ── operations ──────────────────────────────────────────────────────────────

const WEIGHTS = {
  boot: 3,
  lock: 10,
  'unlock.passphrase': 10,
  'unlock.biometric': 6,
  'unlock.open': 12,
  restore: 5,
  setup: 2,
  activate: 4,
  switchTo: 5,
  finishRestore: 4,
  'delete.quiesce': 4,
  'delete.deregister': 3,
  'delete.seal': 3,
  'delete.close': 4,
  'delete.wipe': 1.5,
  'delete.finish': 2,
  retry: 4,
  reprotect: 1.5,
  keystoreStore: 2,
  enableBiometric: 2,
  setHead: 2,
} as const
type OpName = Exclude<keyof typeof WEIGHTS, 'retry'>

/** operations that lead to a rarely reached method, in order: a run focused on it starts with them
 *  (one per step, still overlapping with what the scheduler holds) and draws them more often after */
const REACH: Readonly<Record<string, readonly OpName[]>> = {
  'host.deregister': ['unlock.passphrase', 'unlock.open', 'delete.quiesce', 'delete.deregister'],
  'vault.activate': ['restore', 'switchTo'],
  'vault.setProtection': ['unlock.passphrase', 'unlock.open', 'setHead'],
  'biometric.store': ['unlock.passphrase', 'keystoreStore'],
  'vault.verifyWiped': ['restore', 'switchTo', 'finishRestore'],
}

/** operations whose success means a session was opened, installed or published */
const SESSION_OPS = new Set<string>(['unlock.passphrase', 'unlock.biometric', 'unlock.open', 'activate', 'switchTo', 'reprotect', 'keystoreStore', 'enableBiometric', 'setHead'])
const PUBLISHING_OPS = new Set<string>(['unlock.open', 'activate', 'finishRestore', 'reprotect', 'enableBiometric', 'setHead'])

const norm = (r: unknown): string => {
  if (r === undefined) return 'ok'
  if (r && typeof r === 'object' && 'status' in r) return 'ok' // boot
  const x = r as { ok: boolean; error?: { kind: string; code?: string; reason?: string }; code?: string; local?: { ok: boolean } }
  if ('local' in x && x.local) return x.local.ok ? 'ok' : 'unverified'
  if (x.ok) return 'ok'
  if (x.error) return [x.error.kind, x.error.code ?? x.error.reason].filter(Boolean).join(':')
  return x.code ?? 'failed'
}

interface Op {
  readonly id: number
  readonly name: OpName
  /** serial of the last lock or boot when the op started */
  readonly after: number
  preempted: boolean
  result: string | null
}

async function runSeed(seed: number, focus: string, steps: number): Promise<{ visited: Set<string> }> {
  const { s, d, host, runtime, secrets, violations } = device(seed, focus)
  const id = runtime
  const log: string[] = []
  const r = rng(seed)
  let pendingNs: string | null = null
  let lastFailed: OpName | null = null
  let deleting = false
  let lastClose = -1

  // an unlocked identity with a keystore entry, built without the scheduler
  await runtime.boot()
  const res = await id.setup.reserve('setup', 'passphrase+biometric')
  if (!res.ok) throw new Error('reserve')
  const ns0 = res.value.ns
  /** the passphrase of each identity's vault: a keystore entry holds exactly these bytes */
  const passOf = new Map<string, string>([[ns0, PASSPHRASE]])
  await id.setup.writeVault(ns0, { mnemonic: words(WORDS12), protection: { mode: 'passphrase+biometric', passphrase: secret(PASSPHRASE) }, profile: { name: 'A' }, termsVersion: '2026-10-draft' })
  await id.setup.keystoreAfter(ns0, PROMPT)
  await id.setup.initHolder(ns0)
  await id.setup.activate(ns0)
  await runtime.boot()
  if (r.next() < 0.5) {
    await id.unlock.passphrase(secret(PASSPHRASE))
    await id.unlock.open()
  }
  s.start()

  const ops: Op[] = []
  let lockSerial = -1
  const fail = (msg: string): never => {
    throw new Error(`seed ${seed} (focus ${focus}): ${msg}\n  ops: ${log.join(' | ')}`)
  }

  const body = (name: OpName): (() => Promise<unknown>) => {
    switch (name) {
      case 'boot':
        return () => runtime.boot()
      case 'lock':
        return () => id.lock('user')
      case 'unlock.passphrase':
        return () => id.unlock.passphrase(secret(r.next() < 0.5 ? PASSPHRASE : NEW_PASSPHRASE))
      case 'unlock.biometric':
        return () => id.unlock.biometric(PROMPT)
      case 'unlock.open':
        return () => id.unlock.open()
      case 'restore':
      case 'setup':
        return async () => {
          const flow = name
          const rv = await id.setup.reserve(flow, 'passphrase')
          if (!rv.ok) return rv
          pendingNs = rv.value.ns
          passOf.set(rv.value.ns, NEW_PASSPHRASE)
          const v = await id.setup.writeVault(rv.value.ns, {
            mnemonic: words(flow === 'restore' ? WORDS15 : WORDS12),
            protection: { mode: 'passphrase', passphrase: secret(NEW_PASSPHRASE) },
            profile: flow === 'setup' ? { name: 'B' } : null,
            termsVersion: null,
          })
          if (!v.ok) return v
          return id.setup.initHolder(rv.value.ns)
        }
      case 'activate':
        return () => id.setup.activate((pendingNs ?? null) as never)
      case 'switchTo':
        return () => id.setup.switchTo((pendingNs ?? 'n-none') as never)
      case 'finishRestore':
        return async () => {
          const w = await id.setup.wipeOld()
          if (!w.ok) return w
          await id.setup.verifyOld()
          return id.setup.finishRestore()
        }
      case 'delete.quiesce':
        return () => id.delete.quiesce()
      case 'delete.deregister':
        return () => id.delete.deregister('run').then(() => undefined)
      case 'delete.seal':
        return () => id.delete.seal()
      case 'delete.close':
        return () => id.delete.close()
      case 'delete.wipe':
        return () => id.delete.wipe()
      case 'delete.finish':
        return async () => {
          await id.delete.verify()
          return id.delete.finish()
        }
      case 'reprotect':
        return () => id.unlock.reprotect()
      case 'keystoreStore':
        return () => id.protection.keystoreStore(PROMPT)
      case 'enableBiometric':
        return () => id.unlock.enableBiometric(PROMPT)
      case 'setHead':
        return () => id.protection.setHead(r.next() < 0.5 ? 'passphrase+biometric' : 'passphrase')
    }
  }

  const inventory = () => runtime.inventory()

  const onResult = (op: Op) => {
    log.push(`#${op.id}=${op.result}`)
    if (op.preempted && SESSION_OPS.has(op.name) && op.result === 'ok') fail(`#${op.id} ${op.name} reported success although a lock or boot discarded it`)
    if ((op.name === 'unlock.passphrase' || op.name === 'unlock.biometric') && op.result === 'ok') deleting = false
    if (op.name === 'delete.finish' && op.result === 'ok') {
      deleting = false
      const open = host.openHandles()
      if (open.length > 0) fail(`delete reported success with ${open.length} holder(s) still open`)
      const inv = inventory()
      if (inv.length > 0) fail(`delete reported success with ${inv.length} opening(s) still registered`)
      const later = ops.some((o) => o.id > lastClose && !o.name.startsWith('delete.'))
      if (!later && secrets.some((b) => b.some((x) => x !== 0))) fail('delete reported success with key bytes not overwritten')
    }
    if (op.name === 'delete.close' && op.result === 'ok') lastClose = op.id
    if (op.result !== 'ok') lastFailed = op.name
  }

  const focusMethod = focus.slice(0, focus.lastIndexOf(':'))
  const weights: Record<string, number> = { ...WEIGHTS }
  for (const o of REACH[focusMethod] ?? []) weights[o] = (weights[o] ?? 0) * 6
  const prelude = [...(REACH[focusMethod] ?? [])]
  const pickOp = (): OpName => {
    const scripted = prelude.shift()
    if (scripted) return scripted
    const n = r.weighted(weights) as OpName | 'retry'
    return n === 'retry' ? (lastFailed ?? 'lock') : n
  }

  const start = (name: OpName) => {
    const op: Op = { id: ops.length, name, after: lockSerial, preempted: false, result: null }
    ops.push(op)
    log.push(`${name}#${op.id}`)
    // delete S1 freezes the session: the delete flow owns the screen until finish, a boot or a new session
    if (name === 'delete.quiesce') deleting = true
    if (name === 'boot') deleting = false
    if (name === 'lock' || name === 'boot') {
      for (const o of ops) if (o !== op && o.result === null) o.preempted = true
      lockSerial = op.id
    }
    void current
      .run(op, () => body(name)())
      .then(norm, (e: unknown) => `throw:${e instanceof Error ? e.message : String(e)}`)
      .then((res) => {
        op.result = res
        onResult(op)
      })
  }

  const check = (where: string) => {
    if (violations.length > 0) fail(`${where}: ${violations[0]}`)
    // keystore and vault stay consistent: an entry is the passphrase of that identity's vault, never zeros
    for (const [ns, v] of d.keystore) {
      const pass = passOf.get(ns)
      if (pass && new TextDecoder().decode(v) !== pass) fail(`${where}: keystore entry of ${ns} is not the passphrase of its vault (${v.every((x) => x === 0) ? 'zero bytes' : 'other bytes'})`)
    }
    const st = runtime.state.get()
    const open = host.openHandles()
    const inv = inventory()
    const transit = new Set(s.inTransit())
    // no holder is open without a registered owner, none is forgotten while open
    const known = new Set(inv.map((e) => e.handle))
    for (const h of open) if (!known.has(h) && !transit.has(h)) fail(`${where}: holder of ${h.ns} open without a registered owner`)
    for (const e of inv) if (e.state === 'active' && e.owner === null) fail(`${where}: active opening of ${e.ns} without an owner`)
    if (st.status === 'unlocked' && !deleting) {
      // unlocked ⇔ exactly one open holder of the current session
      const mine = inv.filter((e) => e.owner === 'session' && e.state === 'active')
      if (mine.length !== 1) fail(`${where}: unlocked with ${mine.length} active session holder(s)`)
      if (!open.includes(mine[0]!.handle)) fail(`${where}: unlocked, but the session holder is not open`)
      // a lock is final for everything started before it
      const publisher = ops.some((o) => o.id > lockSerial && PUBLISHING_OPS.has(o.name) && (o.result === null || o.result === 'ok'))
      if (lockSerial >= 0 && !publisher) fail(`${where}: unlocked after lock/boot #${lockSerial} without a later unlock`)
    }
  }

  for (let step = 0; step < steps; step++) {
    s.setStep(step)
    const x = r.next()
    const held = s.held()
    if (x < 0.42 || held.length === 0) {
      start(pickOp())
      // sometimes a second one right away, without awaiting anything in between
      if (r.next() < 0.25) start(pickOp())
    } else {
      const c = r.pick(held)
      log.push(`release:${c.name}#${c.id}`)
      s.release(c)
    }
    await s.pump()
    check(`step ${step}`)
  }

  // drain: release everything in random order until all operations are done
  for (let i = 0; i < 2000; i++) {
    const held = s.held()
    if (held.length === 0 && ops.every((o) => o.result !== null)) break
    if (held.length > 0) {
      const c = r.pick(held)
      log.push(`release:${c.name}#${c.id}`)
      s.release(c)
    }
    await s.pump()
    check(`drain ${i}`)
  }
  if (ops.some((o) => o.result === null)) fail(`operations never finished: ${ops.filter((o) => o.result === null).map((o) => `${o.name}#${o.id}`).join(', ')}`)

  // final lock with every transient fault gone: nothing may stay open or unwiped
  s.calm()
  start('lock')
  for (let i = 0; i < 50 && (s.held().length > 0 || ops.some((o) => o.result === null)); i++) {
    for (const c of s.held()) s.release(c)
    await s.pump()
  }
  await s.pump()
  check('end')
  const st = runtime.state.get()
  if (st.status === 'unlocked') fail('unlocked after the final lock')
  const permanentHost = s.failAlways !== null && HOST_CLOSE_PATH.has(s.failAlways)
  const inv = inventory()
  const open = host.openHandles()
  if (!permanentHost) {
    if (open.length > 0) fail(`after the final lock ${open.length} holder(s) still open`)
    if (inv.length > 0) fail(`after the final lock ${inv.length} opening(s) still registered (${inv.map((e) => e.state).join(', ')})`)
  } else {
    const known = new Set(inv.map((e) => e.handle))
    for (const h of open) if (!known.has(h)) fail(`host fails permanently and the holder of ${h.ns} was forgotten while open`)
    for (const e of inv) if (e.state !== 'closing') fail(`host fails permanently and an opening is ${e.state}, not closing`)
  }
  const dirty = secrets.filter((b) => b.some((v) => v !== 0)).length
  if (dirty > 0) fail(`after the final lock ${dirty} of ${secrets.length} secret buffers not overwritten`)
  return { visited: s.visited }
}

// ── the runs ────────────────────────────────────────────────────────────────

/** five runs focused on each cell */
const SEEDS = Number(process.env.SEEDS ?? 5 * ALL_CELLS.length)
const ONLY = process.env.SEED ? Number(process.env.SEED) : null
const STEPS = 36
const BATCH = 50
const visited = new Set<string>()
const failures: string[] = []

async function runSeeds(from: number, to: number) {
  const mine: string[] = []
  for (let seed = from; seed <= to; seed++) {
    const focus = ALL_CELLS[(seed - 1) % ALL_CELLS.length]!
    try {
      const out = await runSeed(seed, focus, STEPS)
      for (const c of out.visited) visited.add(c)
    } catch (e) {
      mine.push(e instanceof Error ? e.message : String(e))
      if (mine.length >= Number(process.env.MAX_FAILURES ?? 5)) break
    }
  }
  failures.push(...mine)
  expect(mine, mine.join('\n\n')).toEqual([])
}

const batches = ONLY !== null ? [[ONLY, ONLY]] : Array.from({ length: Math.ceil(SEEDS / BATCH) }, (_, i) => [i * BATCH + 1, Math.min(SEEDS, (i + 1) * BATCH)])

describe('identity lifecycle: every cell, every branch', () => {
  afterAll(() => {
    if (process.env.FAIL_LOG) writeFileSync(process.env.FAIL_LOG, failures.join('\n'))
  })
  it.each(batches)('seeds %i to %i keep the ownership and completion contract', async (from, to) => runSeeds(from!, to!), 60_000)
  // the batches above run first (in order); the cells are counted over all of them
  it.runIf(ONLY === null)('every cell (method × behaviour) was visited by some run', () => {
    expect(ALL_CELLS.filter((c) => !visited.has(c)), 'cells no run visited').toEqual([])
  })
})
