import { useEffect, useMemo, useSyncExternalStore } from 'react'
import { AppContextProvider, createLinkInbox, useLinkCollector } from '../hooks'
import { LanguageProvider } from '../i18n'
import { ToastProvider, TooltipProvider } from '../ui/primitives'
import type { ThemeChoice } from '../platform/ports'
import type { Composition } from './compose'
import { ErrorBoundary } from './ErrorBoundary'
import { createNavStore } from './nav'
import { IdentityGate } from './IdentityGate'
import { Shell } from './Shell'

function useTheme(theme: ThemeChoice): void {
  useEffect(() => {
    const root = document.documentElement
    if (theme === 'system') root.removeAttribute('data-theme')
    else root.setAttribute('data-theme', theme)
  }, [theme])
}

export function App({ composition }: { composition: Composition }) {
  const { port, platform, theme, initialNav, flowOverride, identityStart } = composition
  const nav = useMemo(() => createNavStore(initialNav), [initialNav])
  const lang = useSyncExternalStore(platform.language.subscribe, platform.language.current)
  useTheme(theme)
  const ctx = useMemo(() => ({ port, platform, nav }), [port, platform, nav])
  // card links the app is opened with: collected here for the app's lifetime, also while the identity
  // is locked and the shell is not mounted (#491); the shell takes them once it is up
  const links = useMemo(() => createLinkInbox(), [])
  useLinkCollector(platform, links)
  return (
    <LanguageProvider lang={lang}>
      <ErrorBoundary>
        <TooltipProvider delayDuration={300}>
          <ToastProvider>
            <AppContextProvider value={ctx}>
              <IdentityGate override={flowOverride} start={identityStart}>
                <Shell links={links} />
              </IdentityGate>
            </AppContextProvider>
          </ToastProvider>
        </TooltipProvider>
      </ErrorBoundary>
    </LanguageProvider>
  )
}
