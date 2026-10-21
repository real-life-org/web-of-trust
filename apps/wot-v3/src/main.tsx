// Entry: compose → React (architecture §8.1). Storage probe and the live-update check from apps/demo
// (storage-guard.ts, live-update.ts) join with the platform step; the scaffold renders a localized
// error screen when composing fails. Every error the app logs goes through lib/error-filter.ts
// (redaction, foreign-error guard), including React's own reports and uncaught errors.
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './styles/index.css'
import { App } from './app/App'
import { compose } from './app/compose'
import { LanguageProvider } from './i18n'
import { ErrorScreen } from './screens/system/ErrorScreen'
import { installGlobalErrorHandlers, logError } from './lib/error-filter'

installGlobalErrorHandlers(window)

const rootEl = document.getElementById('root')
if (!rootEl) throw new Error('#root missing')
const root = createRoot(rootEl, {
  // ErrorBoundary logs what it catches, redacted; React's default would print the raw error
  onCaughtError: () => undefined,
  onUncaughtError: (error) => logError('uncaught render', error),
  onRecoverableError: (error) => logError('recoverable render', error),
})

function fallbackLanguage(): 'en' | 'de' {
  return (navigator.languages ?? []).some((l) => l.toLowerCase().startsWith('de')) ? 'de' : 'en'
}

compose().then(
  (composition) => {
    root.render(<StrictMode>{'Root' in composition ? <composition.Root /> : <App composition={composition} />}</StrictMode>)
  },
  (err: unknown) => {
    logError('compose', err)
    root.render(
      <LanguageProvider lang={fallbackLanguage()}>
        <ErrorScreen />
      </LanguageProvider>,
    )
  },
)
