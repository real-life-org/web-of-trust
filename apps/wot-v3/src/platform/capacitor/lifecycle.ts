// Native app state, back button and deep links (architecture §5 table: @capacitor/app appStateChange,
// backButton, exitApp, appUrlOpen, getLaunchUrl).

import { App } from '@capacitor/app'
import type { DeepLinkPort, LifecyclePort } from '../ports'
import { backHandlers, isCardLink } from '../web'

/** A listener the plugin registers asynchronously: removed when it arrives if it was dropped meanwhile. */
function listen(add: () => Promise<{ remove: () => Promise<void> }>): () => void {
  let removed = false
  let handle: { remove: () => Promise<void> } | null = null
  add().then(
    (h) => {
      if (removed) void h.remove().catch(() => undefined)
      else handle = h
    },
    () => undefined,
  )
  return () => {
    removed = true
    void handle?.remove().catch(() => undefined)
  }
}

export function capacitorLifecycle(): LifecyclePort {
  const handlers = backHandlers()
  const exit = () => void App.exitApp().catch(() => undefined)
  // one listener for the app's lifetime: the hardware back never leaves the app while a handler holds it
  listen(() => App.addListener('backButton', () => (handlers.dispatch() ? undefined : exit())))
  return {
    onState: (cb) => listen(() => App.addListener('appStateChange', (s) => cb(s.isActive ? 'active' : 'background'))),
    onBack: (cb) => handlers.add(cb),
    exit,
  }
}

export function capacitorDeepLinks(): DeepLinkPort {
  let taken = false
  return {
    async initial() {
      if (taken) return null
      taken = true
      try {
        const url = (await App.getLaunchUrl())?.url ?? null
        return url && isCardLink(url) ? url : null
      } catch {
        return null
      }
    },
    subscribe: (cb) => listen(() => App.addListener('appUrlOpen', (e) => (isCardLink(e.url) ? cb(e.url) : undefined))),
  }
}
