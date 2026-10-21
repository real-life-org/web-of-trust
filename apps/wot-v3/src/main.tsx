// Entry: compose → React (architecture §8.1). Storage probe, foreign-error filter and the
// live-update check from apps/demo (storage-guard.ts, error-filter.ts, live-update.ts) join with
// the platform step; the scaffold renders a localized error screen when composing fails.
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './styles/index.css'
import { App } from './app/App'
import { compose } from './app/compose'
import { LanguageProvider } from './i18n'
import { ErrorScreen } from './screens/system/ErrorScreen'

const rootEl = document.getElementById('root')
if (!rootEl) throw new Error('#root missing')
const root = createRoot(rootEl)

function fallbackLanguage(): 'en' | 'de' {
  return (navigator.languages ?? []).some((l) => l.toLowerCase().startsWith('de')) ? 'de' : 'en'
}

compose().then(
  (composition) => {
    root.render(<StrictMode>{'Root' in composition ? <composition.Root /> : <App composition={composition} />}</StrictMode>)
  },
  (err: unknown) => {
    console.error(err)
    root.render(
      <LanguageProvider lang={fallbackLanguage()}>
        <ErrorScreen />
      </LanguageProvider>,
    )
  },
)
