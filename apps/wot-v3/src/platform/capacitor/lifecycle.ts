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
  // one state for everyone: the WebView's visibility until the plugin answers, its answer at start
  // (unless a change came first), then every change; subscribers hear each change, also the late
  // answer at start (review 432 R4-1)
  let state: 'active' | 'background' = typeof document !== 'undefined' && document.visibilityState === 'hidden' ? 'background' : 'active'
  let changed = false
  const subscribers = new Set<(s: 'active' | 'background') => void>()
  const set = (next: 'active' | 'background') => {
    if (next === state) return
    state = next
    for (const cb of [...subscribers]) cb(next)
  }
  void App.getState().then(
    (s) => {
      if (!changed) set(s.isActive ? 'active' : 'background')
    },
    () => undefined,
  )
  listen(() =>
    App.addListener('appStateChange', (s) => {
      changed = true
      set(s.isActive ? 'active' : 'background')
    }),
  )
  return {
    current: () => state,
    onState(cb) {
      subscribers.add(cb)
      return () => void subscribers.delete(cb)
    },
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
