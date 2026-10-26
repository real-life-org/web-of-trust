// A simulated device for the identity flows: fake platform (keystore, vault, databases, …) whose
// state survives a "process restart", the identity runtime over the simulation holder host, and
// the sim port. restart() builds a new runtime over the same device, like a killed and reopened app.
import { afterAll, expect } from 'vitest'
import { createIdentityRuntime, type HolderHost, type IdentityRuntime } from '../../src/adapters/identity'
import { createSimPort, createSimWorld, simHolderHost, type SimHolders } from '../../src/adapters/sim'
import type { AppPort } from '../../src/port'
import { secret } from '../../src/port'
import {
  createFakePlatform,
  fakeDevice,
  fakeEntropy,
  fakeIdentityPlatform,
  virtualClock,
  type FakeDevice,
  type FakeScreen,
  type IdentityFaults,
} from '../../src/platform/fake'
import type { IdentityPlatform, Platform } from '../../src/platform/ports'
import type { EffectResult, Effect, Row } from '../../src/flows/machine'
import { identityExecutor, type EffectTexts, type FlowRunner } from '../../src/hooks/flow-runner'

export const TEXTS: EffectTexts = {
  unlockPrompt: { title: 'Unlock', subtitle: 'Confirm it is you', cancel: 'Cancel' },
  enrollPrompt: { title: 'Set up biometrics', subtitle: 'Confirm it is you', cancel: 'Cancel' },
}

export interface Process {
  readonly runtime: IdentityRuntime
  readonly port: AppPort
  readonly platform: Platform & { screen: FakeScreen }
  readonly host: ReturnType<typeof simHolderHost>
  readonly exec: ReturnType<typeof identityExecutor>
}

export interface TestDevice {
  readonly device: FakeDevice
  readonly holders: SimHolders
  current(): Process
  /** a new process over the same device; boots the runtime */
  restart(): Promise<Process>
}

let seed = 1

export function testDevice(
  opts: { faults?: Partial<IdentityFaults>; relationships?: number; platform?: (p: IdentityPlatform) => IdentityPlatform; host?: (h: HolderHost) => HolderHost } = {},
): TestDevice {
  const clock = virtualClock(Date.parse('2026-10-15T09:30:00-07:00'), 'America/Los_Angeles')
  const device = fakeDevice(opts.faults)
  const holders: SimHolders = new Map()
  const make = (): Process => {
    const entropy = fakeEntropy(seed++)
    const platform = createFakePlatform({ clock, device, seed: seed++ }) as Platform & { screen: FakeScreen }
    const world = createSimWorld(
      { me: { name: '', anchorShort: '' }, persons: [], contacts: [], groups: [], decisions: [], conversations: [] },
      { clock, entropy },
    )
    const host = simHolderHost(world, holders, device.databases, { relationships: opts.relationships ?? 0 })
    const identityPlatform = fakeIdentityPlatform(device, { clock, entropy })
    const runtime = createIdentityRuntime(opts.platform?.(identityPlatform) ?? identityPlatform, opts.host?.(host) ?? host)
    const port = createSimPort(world, { identity: runtime })
    return { runtime, port, platform, host, exec: identityExecutor(port, platform, TEXTS) }
  }
  let current = make()
  return {
    device,
    holders,
    current: () => current,
    async restart() {
      current = make()
      await current.runtime.boot()
      return current
    },
  }
}

export const s = secret

/** Wraps an executor: the next effect with this id fails with `code` (once). */
export function failing<F extends Effect>(exec: (f: F) => Promise<EffectResult>, plan: Record<string, string | EffectResult>) {
  const left = { ...plan }
  return async (f: F): Promise<EffectResult> => {
    const code = left[f.id]
    if (code !== undefined) {
      delete left[f.id]
      return typeof code === 'string' ? { ok: false, code } : code
    }
    return exec(f)
  }
}

/** Every row of the table is taken by at least one test of the file (architecture §7.2). */
export function tableCoverage(name: string, table: readonly Row[]) {
  const taken = new Set<string>()
  afterAll(() => {
    const missing = table.map((r) => r.id).filter((id) => !taken.has(id))
    expect(missing, `${name}: rows without a transition test`).toEqual([])
  })
  return {
    track<S, E>(runner: FlowRunner<S, E>): FlowRunner<S, E> {
      const record = () => {
        for (const r of runner.rows) taken.add(r)
      }
      const unsub = runner.subscribe(record)
      void unsub
      const send = runner.send
      return {
        ...runner,
        get: runner.get,
        send: (e: E) => {
          send(e)
          record()
        },
        idle: async () => {
          await runner.idle()
          record()
        },
      }
    },
    mark(id: string) {
      taken.add(id)
    },
  }
}

/** Sends events one by one, waiting for all effects after each. */
export async function drive<S, E>(runner: FlowRunner<S, E>, ...events: E[]): Promise<S> {
  await runner.idle()
  for (const e of events) {
    runner.send(e)
    await runner.idle()
  }
  return runner.get()
}

export const PASSPHRASE = 'correct horse battery'
export const PHRASE12 = 'awake print paper end page another thumb raccoon pond guide easily isolate'

/** An identity created through the real port steps (the onboarding effects), then a restart: locked. */
export async function createdIdentity(
  d: TestDevice,
  mode: 'passphrase' | 'passphrase+biometric' | 'biometric-only',
  opts: { words?: string; name?: string } = {},
): Promise<{ ns: string; process: Process }> {
  const p = d.current()
  await p.runtime.boot()
  const id = p.port.identity
  const r = await id.setup.reserve('setup', mode)
  if (!r.ok) throw new Error('reserve')
  const ns = r.value.ns
  if (mode === 'biometric-only') {
    const k = await id.setup.keystoreFirst(ns, TEXTS.enrollPrompt)
    if (!k.ok) throw new Error('keystore')
  }
  const words = s((opts.words ?? PHRASE12).split(' ')) as unknown as Parameters<typeof id.setup.writeVault>[1]['mnemonic']
  const protection = mode === 'biometric-only' ? ({ mode } as const) : ({ mode, passphrase: s(PASSPHRASE) } as const)
  const v = await id.setup.writeVault(ns, { mnemonic: words, protection, profile: { name: opts.name ?? 'Jonas Weber' }, termsVersion: '2026-10-27' })
  if (!v.ok) throw new Error('vault')
  if (mode === 'passphrase+biometric') await id.setup.keystoreAfter(ns, TEXTS.enrollPrompt)
  if (!(await id.setup.initHolder(ns)).ok) throw new Error('init')
  if (!(await id.setup.activate(ns)).ok) throw new Error('activate')
  const process = await d.restart()
  return { ns, process }
}
