// Harness boot (build target "harness" only): builds a simulated world from a scenario and
// composes the app on it. URL parameters: scenario, lang, theme, open (conversation key),
// catalog (an identity screen with a set state, harness/catalog.ts).
// The scenario player (harness.html, architecture §7.3) builds on this.

import type { Composition, HarnessPage } from '../src/app/compose'
import { INITIAL_NAV, type NavState } from '../src/app/nav'
import type { ConversationKey, IdentityNs, Mnemonic, Secret } from '../src/port'
import { secret } from '../src/port'
import { createIdentityRuntime, type IdentityRuntime } from '../src/adapters/identity'
import { createSimPort, createSimWorld, simHolderHost } from '../src/adapters/sim'
import {
  createFakePlatform,
  fakeDevice,
  fakeEntropy,
  fakeIdentityPlatform,
  seedLegacyGen2,
  virtualClock,
  type FakeDevice,
} from '../src/platform/fake'
import type { Scenario } from './scenario'
import { SCENARIOS, iiw } from './scenarios'
import { catalogEntry, TEST_PHRASE } from './catalog'
import { VERIFY_CATALOG } from './catalog-verify'

/** The loopback scenarios with two phones (harness/pair.tsx): not met yet, and met with messages. */
const PAIR_SCENARIOS = ['encounter', 'conversation']

/** Public test values of the harness (never real secrets). */
export const HARNESS_PASSPHRASE = 'harness passphrase'

interface Opts {
  lang?: 'en' | 'de'
  theme?: 'light' | 'dark' | 'system'
  open?: ConversationKey | null
}

function navFor(open: ConversationKey | null | undefined): NavState {
  return open ? { tab: open.startsWith('g:') ? 'groups' : 'contacts', stack: [{ kind: 'chat', key: open }], sheet: null } : INITIAL_NAV
}

/** Scenarios without an identity: the app starts unlocked, no identity runtime (data screens). */
export function composeScenario(scenario: Scenario, opts: Opts = {}): Composition & { world: ReturnType<typeof createSimWorld> } {
  const clock = virtualClock(Date.parse(scenario.clock.start), scenario.clock.timeZone)
  const platform = createFakePlatform({ clock, language: opts.lang ?? scenario.view?.lang ?? 'en' })
  const world = createSimWorld(scenario.world, { clock, entropy: platform.entropy })
  return {
    port: createSimPort(world),
    platform,
    theme: opts.theme ?? scenario.view?.theme ?? 'system',
    initialNav: navFor(opts.open),
    world,
  }
}

/** Scenarios with an identity: fake device, identity runtime, sim holder host; the identity is set
 *  up through the real port steps with the public test phrase, then the runtime boots. */
export async function composeIdentityScenario(
  scenario: Scenario,
  opts: Opts = {},
): Promise<Composition & { device: FakeDevice; runtime: IdentityRuntime }> {
  const id = scenario.identity ?? { state: 'none' as const }
  const clock = virtualClock(Date.parse(scenario.clock.start), scenario.clock.timeZone)
  const device = fakeDevice(id.faults)
  const platform = createFakePlatform({ clock, device, language: opts.lang ?? scenario.view?.lang ?? 'en' })
  const entropy = fakeEntropy(7)
  const world = createSimWorld(scenario.world, { clock, entropy })
  const host = simHolderHost(world, new Map(), device.databases)
  const runtime = createIdentityRuntime(fakeIdentityPlatform(device, { clock, entropy }), host)
  const port = createSimPort(world, { identity: runtime })

  if (id.state === 'legacy-gen2') seedLegacyGen2(device)
  if (id.state === 'locked' || id.state === 'unlocked') {
    const mode = id.protection ?? 'passphrase'
    await runtime.boot()
    const r = await runtime.setup.reserve('setup', mode)
    if (!r.ok) throw new Error('harness: reserve')
    const ns: IdentityNs = r.value.ns
    const prompt = { title: '', subtitle: '', cancel: '' }
    if (mode === 'biometric-only') await runtime.setup.keystoreFirst(ns, prompt)
    await runtime.setup.writeVault(ns, {
      mnemonic: secret(TEST_PHRASE.split(' ')) as unknown as Secret<Mnemonic>,
      protection: mode === 'biometric-only' ? { mode } : { mode, passphrase: secret(HARNESS_PASSPHRASE) },
      profile: { name: scenario.world.me.name },
      termsVersion: runtime.termsConsent().current,
    })
    if (mode === 'passphrase+biometric') await runtime.setup.keystoreAfter(ns, prompt)
    await runtime.setup.initHolder(ns)
    await runtime.setup.activate(ns)
    await runtime.lock('user')
    if (id.bioInvalidated) device.invalidated.add(ns)
  }
  await runtime.boot()
  if (id.state === 'unlocked') {
    await runtime.unlock.passphrase(secret(HARNESS_PASSPHRASE))
    await runtime.unlock.open()
  }
  return {
    port,
    platform,
    theme: opts.theme ?? scenario.view?.theme ?? 'system',
    initialNav: navFor(opts.open),
    ...(id.startFlow ? { identityStart: id.startFlow } : {}),
    device,
    runtime,
  }
}

function isKey(v: string | null): v is ConversationKey {
  return v !== null && /^[cg]:.+/.test(v)
}

export async function bootHarness(url: URL): Promise<Composition | HarnessPage> {
  const p = url.searchParams
  if (PAIR_SCENARIOS.includes(p.get('scenario') ?? '')) {
    const { bootPair } = await import('./pair')
    return bootPair(url)
  }
  const lang = p.get('lang')
  const theme = p.get('theme')
  const open = p.get('open')
  const opts: Opts = {
    ...(lang === 'en' || lang === 'de' ? { lang } : {}),
    ...(theme === 'light' || theme === 'dark' || theme === 'system' ? { theme } : {}),
    open: isKey(open) ? open : null,
  }
  const entry = catalogEntry(p.get('catalog')) ?? VERIFY_CATALOG.find((e) => e.id === p.get('catalog')) ?? null
  if (entry) return { ...composeScenario(iiw, opts), flowOverride: entry.override }
  const scenario = SCENARIOS[p.get('scenario') ?? ''] ?? iiw
  return scenario.identity ? composeIdentityScenario(scenario, opts) : composeScenario(scenario, opts)
}
