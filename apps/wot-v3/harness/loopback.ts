// Loopback devices (architecture §3.3): the real adapter on the real library, each device with its
// own fake platform (vault, keystore, prefs), its own in-memory IndexedDB (fake-indexeddb, so every
// page load starts clean) and one endpoint on a shared in-memory carrier. Identities are set up
// through the real port steps with public test phrases; states come only from real holder acts.

import { IDBFactory } from 'fake-indexeddb'
import { createRltpPort, memoryCarrier, type MemoryCarrier, type RltpFaults, type RltpPort } from '../src/adapters/rltp'
import type { IdentityNs, Mnemonic, Secret } from '../src/port'
import { secret } from '../src/port'
import { createFakePlatform, fakeDevice, fakeEntropy, fakeIdentityPlatform, type FakeDevice, type VirtualClock } from '../src/platform/fake'
import type { Language, Platform } from '../src/platform/ports'
import { webDatabases } from '../src/platform/web/identity'

/** Public BIP-39 test phrases (vectors), one per loopback person. Never real secrets. */
export const LOOPBACK_PHRASES = [
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about',
  'legal winner thank year wave sausage worth useful legal winner thank yellow',
  'letter advice cage absurd amount doctor acoustic avoid letter advice cage above',
] as const

export const LOOPBACK_PASSPHRASE = 'harness passphrase'

export interface LoopbackDevice {
  readonly id: string
  readonly port: RltpPort
  readonly platform: Platform
  readonly device: FakeDevice
  readonly faults: RltpFaults
}

export { memoryCarrier, type MemoryCarrier }

export async function loopbackDevice(opts: {
  carrier: MemoryCarrier
  id: string
  name: string
  words: string
  clock: VirtualClock
  seed: number
  language?: Language
}): Promise<LoopbackDevice> {
  const device = fakeDevice()
  const entropy = fakeEntropy(opts.seed)
  const platform = createFakePlatform({ clock: opts.clock, device, seed: opts.seed + 1, ...(opts.language ? { language: opts.language } : {}) })
  // the wipe deletes and verifies the databases the adapter really writes (review 420 R8-3)
  const idb = new IDBFactory()
  const identity = fakeIdentityPlatform(device, { clock: opts.clock, entropy, databases: webDatabases(idb) })
  const faults: RltpFaults = { killAt: null }
  const port = createRltpPort({
    faults,
    identity,
    idb,
    transport: opts.carrier.endpoint(opts.id),
    // two phones in one page: each device has its own writer
    writer: { acquire: async () => () => undefined },
  })
  const rt = port.runtime
  await rt.boot()
  const r = await rt.setup.reserve('setup', 'passphrase')
  if (!r.ok) throw new Error('loopback: reserve')
  const ns: IdentityNs = r.value.ns
  const w = await rt.setup.writeVault(ns, {
    mnemonic: secret(opts.words.split(' ')) as unknown as Secret<Mnemonic>,
    protection: { mode: 'passphrase', passphrase: secret(LOOPBACK_PASSPHRASE) },
    profile: { name: opts.name },
    termsVersion: rt.termsConsent().current,
  })
  if (!w.ok) throw new Error('loopback: vault')
  const i = await rt.setup.initHolder(ns)
  if (!i.ok) throw new Error('loopback: init')
  const a = await rt.setup.activate(ns)
  if (!a.ok) throw new Error('loopback: activate')
  return { id: opts.id, port, platform, device, faults }
}
