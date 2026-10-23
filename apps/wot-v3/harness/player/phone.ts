// One phone of the scenario player (architecture §7.3): an app instance with its own fake device,
// identity runtime, simulated holder and world, composed inside the phone's iframe. The player
// drives it through the PhoneController: clock, fault switches, world actions, language, theme.
//
// Faults: transport (connectivity store: carrier unreachable, queued count), vault (every seed
// vault write transaction aborts), biometrics (keystore reports none), host close (S5 of the
// holder host throws), camera (denied or none), share (sheet and mail app do not open), storage full
// (space low, every vault write aborts with QuotaExceededError). A phone in catalog mode shows a set flow state and has no identity runtime;
// vault, biometrics and host close then have nothing to act on.

import type { Composition } from '../../src/app/compose'
import type { HolderHost } from '../../src/adapters/identity'
import type { SimWorld } from '../../src/adapters/sim'
import type { FakeDevice, VirtualClock } from '../../src/platform/fake'
import type { FakePlatform } from '../boot'
import type { Connectivity } from '../../src/port'
import { writableStore } from '../../src/port'
import { NO_FAULTS, type PlayerFaults, type Scenario } from '../scenario'
import { catalogEntry } from '../catalog'
import { composeIdentityScenario, composeScenario } from '../boot'
import type { PhoneController, PlayerLang, PlayerTheme } from './player'

export interface PhoneOptions {
  readonly index: number
  readonly lang?: PlayerLang
  readonly theme?: PlayerTheme
  /** a screen-catalog entry (harness/catalog.ts) instead of the live identity */
  readonly catalog?: string | null
}

const ONLINE: Connectivity = { network: 'online', carrier: 'connected', queued: 0, open: 0, carriage: {}, lastReceiveAt: null, projection: 'current', clock: 'ok' }

/** Raised by the wrapped holder host while the fault is on. */
export class HostCloseFault extends Error {
  constructor() {
    super('harness fault: holder host close failed')
    this.name = 'HostCloseFault'
  }
}

export async function createPhone(scenario: Scenario, opts: PhoneOptions): Promise<{ composition: Composition; controller: PhoneController }> {
  let faults: PlayerFaults = NO_FAULTS
  const view = { ...(opts.lang ? { lang: opts.lang } : {}), ...(opts.theme ? { theme: opts.theme } : {}) }
  const entry = opts.catalog ? catalogEntry(opts.catalog) : null

  let base: Composition
  let clock: VirtualClock
  let world: SimWorld
  let device: FakeDevice | null = null
  let fake: FakePlatform
  let openHolders: () => number = () => 0
  if (entry) {
    const c = composeScenario(scenario, view)
    base = { ...c, flowOverride: entry.override }
    clock = c.clock
    world = c.world
    fake = c.fake
  } else {
    // Data scenarios run with an unlocked identity, so every fault switch has a runtime to act on.
    const identity = scenario.identity ?? { state: 'unlocked' as const, protection: 'passphrase+biometric' as const }
    const wrapHost = (host: HolderHost): HolderHost => ({
      ...host,
      async close(holder) {
        if (faults.hostClose === 'fails') throw new HostCloseFault()
        return host.close(holder)
      },
    })
    const c = await composeIdentityScenario({ ...scenario, identity }, { ...view, wrapHost })
    base = c
    clock = c.clock
    world = c.world
    fake = c.fake
    device = c.device
    openHolders = () => c.host.openHandles().length
  }
  const bioBase = device?.faults.biometric ?? 'ok'

  // Connectivity under the player's control (transport fault, clock set back below the high-water mark).
  const connectivity = writableStore<Connectivity>(ONLINE)
  let highWater = clock.now()
  let queued = 0
  const publishConnectivity = () =>
    connectivity.set({
      ...ONLINE,
      carrier: faults.transport === 'down' ? 'unreachable' : 'connected',
      queued,
      clock: clock.now() < highWater ? 'behind' : 'ok',
    })

  const port = base.port
  const composition: Composition = { ...base, port: { ...port, stores: { ...port.stores, connectivity } } }

  const controller: PhoneController = {
    index: opts.index,
    now: () => clock.now(),
    advance(ms) {
      clock.advance(ms)
      highWater = Math.max(highWater, clock.now())
      publishConnectivity()
    },
    rewind(ms) {
      clock.rewind(ms)
      publishConnectivity()
    },
    sync(at, mark) {
      if (at > clock.now()) clock.advance(at - clock.now())
      else if (at < clock.now()) clock.rewind(clock.now() - at)
      highWater = mark
      publishConnectivity()
    },
    setFaults(next, q) {
      faults = next
      queued = q
      fake.scanner.camera = next.camera
      fake.share.fails = next.share === 'fails'
      fake.mail.available = next.share !== 'fails'
      if (device) {
        device.faults.biometric = next.biometric === 'unavailable' ? 'unavailable' : bioBase
        device.faults.space = next.storage === 'full' ? 'low' : 'ok'
        device.vault.beforeCommit =
          next.storage === 'full'
            ? () => {
                throw new DOMException('harness fault: storage full', 'QuotaExceededError')
              }
            : next.vault === 'fails'
              ? () => {
                  throw new Error('harness fault: vault write failed')
                }
              : null
      }
      publishConnectivity()
    },
    apply: (action) => world.apply(action),
    setLang: (lang) => base.platform.language.set(lang),
    setTheme(theme) {
      if (typeof document === 'undefined') return
      const root = document.documentElement
      if (theme === 'system') root.removeAttribute('data-theme')
      else root.setAttribute('data-theme', theme)
    },
    inspect() {
      const identity = port.stores.identity.get()
      const contacts = port.stores.contacts.get()
      return {
        phone: opts.index + 1,
        scenario: scenario.id,
        mode: entry ? `catalog ${entry.id}` : 'live',
        now: new Date(clock.now()).toISOString(),
        identity: identity.status,
        openHolders: openHolders(),
        connectivity: connectivity.get(),
        faults,
        contacts: contacts.status === 'ready' ? contacts.value.length : contacts.status,
        // operation names of the fake device, no values
        deviceLog: device ? device.log.slice(-6) : [],
      }
    },
  }
  return { composition, controller }
}
