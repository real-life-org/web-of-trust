// Canary (architecture §5 "Secret<T> zur Laufzeit"): the words and the passphrase travel field →
// machine → port → runtime → vault and must not arrive anywhere they stay or leave: logs, machine
// snapshots, resume markers, sealed init, prefs, holder logs, events, and the raw content of every
// IndexedDB database, except as the vault's AES-GCM ciphertext. Runs over a real IndexedDB vault
// (fake-indexeddb), the full onboarding and a recovery.
// @vitest-environment node
import { IDBFactory } from 'fake-indexeddb'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createIdentityRuntime, rootIkmFromWords } from '../src/adapters/identity'
import { createSimPort, createSimWorld, simHolderHost } from '../src/adapters/sim'
import { createSeedVault, idbVaultBackend, b64url } from '../src/platform/seed-vault'
import { createFakePlatform, fakeDevice, fakeEntropy, fakeIdentityPlatform, virtualClock } from '../src/platform/fake'
import type { AppEvent, Mnemonic, Secret } from '../src/port'
import { secret } from '../src/port'
import { onboarding, onboardingStart, recovery, recoveryStart, type SetupEvent } from '../src/flows/setup'
import { unlock, unlockStart } from '../src/flows/unlock'
import { createFlowRunner, identityExecutor } from '../src/hooks/flow-runner'
import { drive, TEXTS } from './flows/world'

const CANARY_PASSPHRASE = `canary-${'8f3e2c1a-77b4-4d1e-9a0c-5b6d7e8f9a01'}`
// a valid 15-word phrase in an order no test elsewhere uses (canary for the recovery path)
const CANARY_WORDS = 'before slab path face tennis argue various cotton profit marble educate learn embrace student excess'.split(' ')

async function dumpIdb(factory: IDBFactory): Promise<string> {
  const out: string[] = []
  for (const { name } of await factory.databases()) {
    if (!name) continue
    const db = await new Promise<IDBDatabase>((res, rej) => {
      const r = factory.open(name)
      r.onsuccess = () => res(r.result)
      r.onerror = () => rej(r.error)
    })
    for (const store of [...db.objectStoreNames]) {
      const t = db.transaction(store, 'readonly')
      const values = await new Promise<unknown[]>((res) => {
        const r = t.objectStore(store).getAll()
        r.onsuccess = () => res(r.result)
      })
      const keys = await new Promise<IDBValidKey[]>((res) => {
        const r = t.objectStore(store).getAllKeys()
        r.onsuccess = () => res(r.result)
      })
      out.push(JSON.stringify({ name, store, keys, values }, (_k, v: unknown) => (v instanceof Uint8Array ? Buffer.from(v).toString('hex') : v)))
    }
    db.close()
  }
  return out.join('\n')
}

/** Every way a word sequence, the passphrase or the root IKM could appear in text. */
function needles(words: readonly string[]): string[] {
  const out = [CANARY_PASSPHRASE]
  for (let i = 0; i + 3 <= words.length; i++) {
    const tri = words.slice(i, i + 3)
    out.push(tri.join(' '), tri.join(','), tri.join('","'), tri.join('\n'), tri.join('\\n'))
  }
  const ikm = rootIkmFromWords(words)
  out.push(Buffer.from(ikm).toString('hex'), b64url(ikm), Buffer.from(ikm).toString('base64'))
  return out
}

describe('canary: words and passphrase never arrive where they stay or leave', () => {
  const logs: string[] = []
  beforeEach(() => {
    for (const level of ['log', 'info', 'warn', 'error', 'debug'] as const) {
      vi.spyOn(console, level).mockImplementation((...args: unknown[]) => void logs.push(args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ')))
    }
  })
  afterEach(() => vi.restoreAllMocks())

  it('onboarding and recovery over a real IndexedDB vault', async () => {
    const factory = new IDBFactory()
    const clock = virtualClock(Date.parse('2026-10-15T09:30:00-07:00'), 'UTC')
    const device = fakeDevice({ biometric: 'unavailable' })
    const holders = new Map()
    const snapshots: string[] = []
    const events: AppEvent[] = []

    const proc = () => {
      const entropy = fakeEntropy(99)
      const platform = createFakePlatform({ clock, device })
      const world = createSimWorld({ me: { name: '', anchorShort: '' }, persons: [], contacts: [], groups: [], decisions: [], conversations: [] }, { clock, entropy })
      const host = simHolderHost(world, holders, device.databases)
      const identity = { ...fakeIdentityPlatform(device, { clock, entropy }), vault: createSeedVault(idbVaultBackend(factory), { clock, entropy, iterations: 1000 }) }
      const runtime = createIdentityRuntime(identity, host)
      const port = createSimPort(world, { identity: runtime })
      port.events.subscribe((e) => void events.push(e))
      runtime.state.subscribe(() => snapshots.push(JSON.stringify(runtime.state.get())))
      return { runtime, port, platform, host, exec: identityExecutor(port, platform, TEXTS) }
    }

    // onboarding: the generated words are the canary of this path
    let p = proc()
    await p.runtime.boot()
    const ob = createFlowRunner(onboarding, onboardingStart('2026-10-draft'), p.exec.setup, p.platform)
    ob.subscribe(() => snapshots.push(JSON.stringify(ob.get())))
    await drive(ob, { type: 'create' })
    const shown = ob.get()
    if (shown.name !== 'showWords') throw new Error(shown.name)
    const generated = [...shown.words.reveal()]
    await drive(ob, { type: 'toggle', index: 0 }, { type: 'toggle', index: 1 }, { type: 'toggle', index: 2 }, { type: 'next' }, { type: 'next' })
    const v = ob.get()
    if (v.name !== 'verifyWords') throw new Error(v.name)
    await drive(ob, ...v.positions.map((pos, i): SetupEvent => ({ type: 'input', index: i, value: secret(generated[pos] ?? '') })), { type: 'check' })
    await drive(ob, { type: 'name', value: 'Canary' }, { type: 'terms', value: true }, { type: 'next' }, { type: 'choosePassphrase' })
    await drive(ob, { type: 'p1', value: secret(CANARY_PASSPHRASE) }, { type: 'p2', value: secret(CANARY_PASSPHRASE) }, { type: 'next' })
    expect(ob.get().name).toBe('done')

    // restart, unlock with the canary passphrase
    p = proc()
    await p.runtime.boot()
    const st = p.runtime.state.get()
    if (st.status !== 'locked') throw new Error(st.status)
    const un = createFlowRunner(unlock, unlockStart(st), p.exec.unlock, p.platform)
    un.subscribe(() => snapshots.push(JSON.stringify(un.get())))
    await drive(un, { type: 'value', value: secret(CANARY_PASSPHRASE) }, { type: 'submit' })
    expect(['offerBiometric', 'exit']).toContain(un.get().name)

    // recovery with the canary words over the existing identity
    const rec = createFlowRunner(recovery, recoveryStart({ hasIdentity: true, termsValid: true, termsVersion: '2026-10-draft' }), p.exec.setup, p.platform)
    rec.subscribe(() => snapshots.push(JSON.stringify(rec.get())))
    await drive(
      rec,
      { type: 'words', text: secret(CANARY_WORDS.join(' ')), words: secret(CANARY_WORDS) as unknown as Secret<Mnemonic>, count: 15, check: 'ok' },
      { type: 'next' },
      { type: 'next' },
      { type: 'choosePassphrase' },
      { type: 'p1', value: secret(CANARY_PASSPHRASE) },
      { type: 'p2', value: secret(CANARY_PASSPHRASE) },
      { type: 'next' },
    )
    expect(rec.get().name).toBe('done')

    const idb = await dumpIdb(factory)
    expect(idb).toContain('"ct"') // the vault is there, as ciphertext
    const places: Record<string, string> = {
      logs: logs.join('\n'),
      'machine snapshots': snapshots.join('\n'),
      events: JSON.stringify(events),
      'raw IndexedDB': idb,
      'resume marker and sealed init (memory meta)': JSON.stringify([...device.vault.stores.meta]),
      prefs: JSON.stringify([...device.prefs]),
      'device and holder logs': JSON.stringify([device.log, p.host.log, [...holders.values()].map((h) => ({ ...h, actIds: [...h.actIds] }))]),
    }
    for (const words of [generated, CANARY_WORDS]) {
      for (const n of needles(words)) {
        for (const [where, text] of Object.entries(places)) expect(text.includes(n), `${where} contains a secret (${n.slice(0, 12)}…)`).toBe(false)
      }
    }
    expect(snapshots.join('\n')).toContain('[redacted]')
  })
})
