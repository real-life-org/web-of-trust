// Entry of harness.html (build target "harness" only, architecture §7.3). Three modes on one page:
// without ?phone the scenario player; with ?phone=<n> one phone of it, an app instance that attaches
// its controller to the player in window.parent; with ?measure=kdf the unlock measurement (§5.2). Each phone is its own realm (iframe): its own React,
// its own Secret store, its own fake device; the player talks to it only with plain data.
import { StrictMode, useEffect } from 'react'
import { createRoot } from 'react-dom/client'
import '../../src/styles/index.css'
import { App } from '../../src/app/App'
import { TooltipProvider } from '../../src/ui/primitives'
import { createPlayer, type PhoneController, type PlayerHost, type PlayerLang, type PlayerTheme } from './player'
import type { Composition } from '../../src/app/compose'
import { createPhone } from './phone'
import { PLAYER_SCENARIOS } from './scenarios'
import { PlayerApp } from './ui/PlayerApp'
import { KdfMeasure } from '../kdf-measure'

declare global {
  interface Window {
    __wotPlayer?: PlayerHost
  }
}

const rootEl = document.getElementById('root')
if (!rootEl) throw new Error('#root missing')
const root = createRoot(rootEl)
const url = new URL(window.location.href)
const q = url.searchParams

function parentPlayer(): PlayerHost | null {
  try {
    return window.parent !== window ? (window.parent.__wotPlayer ?? null) : null
  } catch {
    return null
  }
}

/** Attaches the controller after the app's first commit: child effects (the app's own theme effect)
 *  run before this one, so the player's current theme and language win over the initial ones. */
function PhoneRoot({ composition, controller, host }: { composition: Composition; controller: PhoneController; host: PlayerHost | null }) {
  useEffect(() => {
    if (!host) return
    host.attach(controller)
    return () => host.detach(controller)
  }, [host, controller])
  return <App composition={composition} />
}

async function bootPhone(index: number): Promise<void> {
  const scenario = PLAYER_SCENARIOS[q.get('scenario') ?? ''] ?? PLAYER_SCENARIOS.iiw
  if (!scenario) throw new Error('player: no scenario')
  const lang = q.get('lang')
  const theme = q.get('theme')
  const { composition, controller } = await createPhone(scenario, {
    index,
    ...(lang === 'en' || lang === 'de' ? { lang: lang as PlayerLang } : {}),
    ...(theme === 'light' || theme === 'dark' || theme === 'system' ? { theme: theme as PlayerTheme } : {}),
    catalog: q.get('catalog'),
  })
  const host = parentPlayer()
  root.render(
    <StrictMode>
      <PhoneRoot composition={composition} controller={controller} host={host} />
    </StrictMode>,
  )
  if (host) window.addEventListener('pagehide', () => host.detach(controller))
}

function bootPlayer(): void {
  const player = createPlayer(PLAYER_SCENARIOS, { initial: q.get('scenario') ?? 'iiw-duo' })
  window.__wotPlayer = player
  const options = Object.values(PLAYER_SCENARIOS).map((s) => ({ value: s.id, label: `${s.title} (${s.id})` }))
  root.render(
    <StrictMode>
      <TooltipProvider>
        <PlayerApp player={player} scenarioOptions={options} />
      </TooltipProvider>
    </StrictMode>,
  )
}

const phone = q.get('phone')
if (q.get('measure') === 'kdf') {
  root.render(
    <StrictMode>
      <KdfMeasure />
    </StrictMode>,
  )
} else if (phone !== null) {
  bootPhone(Number(phone)).catch((err: unknown) => {
    console.error(err)
    rootEl.textContent = `Phone ${phone} failed to start: ${err instanceof Error ? err.message : String(err)}`
  })
} else {
  bootPlayer()
}
