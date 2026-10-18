import { useEffect, useMemo, useSyncExternalStore } from 'react'
import { AppContextProvider } from '../hooks'
import { LanguageProvider } from '../i18n'
import { ToastProvider, TooltipProvider } from '../ui/primitives'
import type { ThemeChoice } from '../platform/ports'
import type { Composition } from './compose'
import { ErrorBoundary } from './ErrorBoundary'
import { createNavStore } from './nav'
import { Shell } from './Shell'

function useTheme(theme: ThemeChoice): void {
  useEffect(() => {
    const root = document.documentElement
    if (theme === 'system') root.removeAttribute('data-theme')
    else root.setAttribute('data-theme', theme)
  }, [theme])
}

export function App({ composition }: { composition: Composition }) {
  const { port, platform, theme, initialNav } = composition
  const nav = useMemo(() => createNavStore(initialNav), [initialNav])
  const lang = useSyncExternalStore(platform.language.subscribe, platform.language.current)
  useTheme(theme)
  const ctx = useMemo(() => ({ port, platform, nav }), [port, platform, nav])
  return (
    <LanguageProvider lang={lang}>
      <ErrorBoundary>
        <TooltipProvider delayDuration={300}>
          <ToastProvider>
            <AppContextProvider value={ctx}>
              <Shell />
            </AppContextProvider>
          </ToastProvider>
        </TooltipProvider>
      </ErrorBoundary>
    </LanguageProvider>
  )
}
