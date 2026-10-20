// Entry of harness.html (build target "harness" only, architecture §7.3). Two modes on one page:
// without ?phone the scenario player; with ?phone=<n> one phone of it, an app instance that attaches
// its controller to the player in window.parent. Each phone is its own realm (iframe): its own React,
// its own Secret store, its own fake device; the player talks to it only with plain data.
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import '../../src/styles/index.css'
import { App } from '../../src/app/App'
import { TooltipProvider } from '../../src/ui/primitives'
import { createPlayer, type PlayerHost, type PlayerLang, type PlayerTheme } from './player'
import { createPhone } from './phone'
import { PLAYER_SCENARIOS } from './scenarios'
import { PlayerApp } from './ui/PlayerApp'

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
  root.render(
    <StrictMode>
      <App composition={composition} />
    </StrictMode>,
  )
  const host = parentPlayer()
  if (host) {
    host.attach(controller)
    window.addEventListener('pagehide', () => host.detach(controller))
  }
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
if (phone !== null) {
  bootPhone(Number(phone)).catch((err: unknown) => {
    console.error(err)
    rootEl.textContent = `Phone ${phone} failed to start: ${err instanceof Error ? err.message : String(err)}`
  })
} else {
  bootPlayer()
}
