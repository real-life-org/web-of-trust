// Harness boot (build target "harness" only): builds a simulated world from a scenario and
// composes the app on it. URL parameters: scenario, lang, theme, open (conversation key).
// The scenario player (harness.html, architecture §7.3) builds on this.

import type { Composition } from '../src/app/compose'
import { INITIAL_NAV, type NavState } from '../src/app/nav'
import type { ConversationKey } from '../src/port'
import { createSimPort, createSimWorld } from '../src/adapters/sim'
import { createFakePlatform, virtualClock } from '../src/platform/fake'
import type { Scenario } from './scenario'
import { SCENARIOS, iiw } from './scenarios'

export function composeScenario(
  scenario: Scenario,
  opts: { lang?: 'en' | 'de'; theme?: 'light' | 'dark' | 'system'; open?: ConversationKey | null } = {},
): Composition & { world: ReturnType<typeof createSimWorld> } {
  const clock = virtualClock(Date.parse(scenario.clock.start), scenario.clock.timeZone)
  const platform = createFakePlatform({ clock, language: opts.lang ?? scenario.view?.lang ?? 'en' })
  const world = createSimWorld(scenario.world, { clock, entropy: platform.entropy })
  const initialNav: NavState = opts.open
    ? { tab: opts.open.startsWith('g:') ? 'groups' : 'contacts', stack: [{ kind: 'chat', key: opts.open }], sheet: null }
    : INITIAL_NAV
  return {
    port: createSimPort(world),
    platform,
    theme: opts.theme ?? scenario.view?.theme ?? 'system',
    initialNav,
    world,
  }
}

function isKey(v: string | null): v is ConversationKey {
  return v !== null && /^[cg]:.+/.test(v)
}

export function bootHarness(url: URL): Composition {
  const p = url.searchParams
  const scenario = SCENARIOS[p.get('scenario') ?? ''] ?? iiw
  const lang = p.get('lang')
  const theme = p.get('theme')
  const open = p.get('open')
  return composeScenario(scenario, {
    ...(lang === 'en' || lang === 'de' ? { lang } : {}),
    ...(theme === 'light' || theme === 'dark' || theme === 'system' ? { theme } : {}),
    open: isKey(open) ? open : null,
  })
}
