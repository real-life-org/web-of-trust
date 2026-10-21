// Web lifecycle, back and deep links (architecture §5 table: visibilitychange, popstate; location and
// hashchange). The Capacitor shell reuses the dispatch of back handlers (platform/capacitor).

import type { DeepLinkPort, LifecyclePort, LiveUpdatePort } from '../ports'

/** Back handlers, newest first; true = handled. Shared by the web and the native lifecycle. */
export function backHandlers(): { add(cb: () => boolean): () => void; dispatch(): boolean; readonly size: number } {
  const list: (() => boolean)[] = []
  return {
    add(cb) {
      list.push(cb)
      return () => {
        const i = list.lastIndexOf(cb)
        if (i >= 0) list.splice(i, 1)
      }
    },
    dispatch() {
      for (const cb of [...list].reverse()) {
        try {
          if (cb()) return true
        } catch {
          // a failing handler counts as handled: the app never leaves on an error
          return true
        }
      }
      return false
    },
    get size() {
      return list.length
    },
  }
}

/** Foreground and background from the page's visibility; back from popstate over one guard entry
 *  in the history (pushed while handlers exist, pushed again after a handled back). A back nobody
 *  handled lets the browser go where it was going. */
export function webLifecycle(): LifecyclePort {
  const handlers = backHandlers()
  let guarded = false
  let leaving = false
  const arm = () => {
    if (guarded || handlers.size === 0 || typeof window === 'undefined') return
    try {
      window.history.pushState({ wotBack: true }, '')
      guarded = true
    } catch {
      // a sandboxed frame may refuse history writes: back then leaves the page
    }
  }
  if (typeof window !== 'undefined') {
    window.addEventListener('popstate', () => {
      if (leaving) {
        // the step past the page's own entry (below) landed on an entry of this page: done
        leaving = false
        return
      }
      guarded = false
      if (handlers.dispatch()) return arm()
      // nobody took it: the browser goes where it was going, past the page's own entry (review 432 R2-6)
      leaving = true
      window.history.back()
    })
  }
  return {
    current: () => (typeof document !== 'undefined' && document.visibilityState === 'hidden' ? 'background' : 'active'),
    onState(cb) {
      if (typeof document === 'undefined') return () => undefined
      const on = () => cb(document.visibilityState === 'visible' ? 'active' : 'background')
      document.addEventListener('visibilitychange', on)
      return () => document.removeEventListener('visibilitychange', on)
    },
    onBack(cb) {
      const off = handlers.add(cb)
      arm()
      return off
    },
    // a page cannot close itself; leaving is the browser's back
    exit: () => undefined,
  }
}

/** A link the app takes: `…/c#<card>` (§5.3). Everything else is not a deep link of the app. */
export function isCardLink(url: string): boolean {
  try {
    const u = new URL(url)
    return /\/c\/?$/.test(u.pathname) && u.hash.length > 1
  } catch {
    return false
  }
}

/** The web: the page's own URL at start, and later hash changes. After the hand-over the fragment is
 *  removed from the address bar (replaceState), so it stays neither in the bar nor in the history. */
export function webDeepLinks(): DeepLinkPort {
  let taken = false
  const takeCurrent = (): string | null => {
    if (typeof location === 'undefined') return null
    const href = location.href
    if (!isCardLink(href)) return null
    try {
      history.replaceState(history.state, '', location.pathname + location.search)
    } catch {
      // the fragment stays in the bar; the app never logs it (§5 redaction)
    }
    return href
  }
  // taken at once, when the platform is built: the fragment leaves the address bar before any history
  // entry (the back guard) can copy it (review 432 R4-3)
  let launch = takeCurrent()
  return {
    async initial() {
      if (taken) return null
      taken = true
      const url = launch
      launch = null
      return url
    },
    subscribe(cb) {
      if (typeof window === 'undefined') return () => undefined
      const on = () => {
        const url = takeCurrent()
        if (url) cb(url)
      }
      window.addEventListener('hashchange', on)
      return () => window.removeEventListener('hashchange', on)
    },
  }
}

/** The web has no live update (no-op). */
export const liveUpdateOff: LiveUpdatePort = { enabled: false, check: async () => undefined }
