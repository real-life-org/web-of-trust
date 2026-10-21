// Web implementations of the platform ports (architecture §5). Only the ports the scaffold needs.

import type { ClockPort, EntropyPort, Language, LanguagePort, Platform, PrefsPort, ScannerPort } from '../ports'
import { webClipboard, webScreenProtection } from './identity'

export * from './identity'

export const webClock: ClockPort = {
  now: () => Date.now(),
  setTimer(at, cb) {
    // setTimeout holds at most 2^31 − 1 ms (about 24.8 days): a later time is reached in steps
    // (journal limits run to 89 days; a longer delay would fire at once, review 421 R13-6)
    const MAX = 2_147_483_647
    let id: ReturnType<typeof setTimeout>
    const arm = () => {
      const wait = at - Date.now()
      id = setTimeout(wait > MAX ? arm : cb, Math.min(MAX, Math.max(0, wait)))
    }
    arm()
    return () => clearTimeout(id)
  },
  timeZone: () => Intl.DateTimeFormat().resolvedOptions().timeZone,
}

export const webEntropy: EntropyPort = {
  uuid: () => crypto.randomUUID(),
  bytes(n) {
    const out = new Uint8Array(n)
    crypto.getRandomValues(out)
    return out
  },
}

export function webPrefs(prefix = 'wot-v3:'): PrefsPort {
  const all = (): string[] => {
    try {
      return Object.keys(localStorage).filter((k) => k.startsWith(prefix))
    } catch {
      return []
    }
  }
  return {
    get(k) {
      try {
        return localStorage.getItem(prefix + k)
      } catch {
        return null
      }
    },
    set(k, v) {
      try {
        localStorage.setItem(prefix + k, v)
      } catch {
        // storage blocked: preferences are best effort
      }
    },
    remove(k) {
      try {
        localStorage.removeItem(prefix + k)
      } catch {
        // ignore
      }
    },
    keys(p = '') {
      return all()
        .map((k) => k.slice(prefix.length))
        .filter((k) => k.startsWith(p))
    },
    wipe() {
      try {
        for (const key of all()) localStorage.removeItem(key)
      } catch {
        // ignore
      }
    },
  }
}

function pick(candidates: readonly string[]): Language | null {
  for (const c of candidates) {
    const base = c.toLowerCase().split('-')[0]
    if (base === 'en' || base === 'de') return base
  }
  return null
}

/** Language rule on the web: ?lang= → prefs → navigator.languages → en (architecture §5). */
export function webLanguage(prefs: PrefsPort): LanguagePort {
  const listeners = new Set<() => void>()
  const fromUrl = pick([new URLSearchParams(location.search).get('lang') ?? ''])
  let current: Language = fromUrl ?? pick([prefs.get('lang') ?? '']) ?? pick(navigator.languages ?? []) ?? 'en'
  return {
    system: () => navigator.languages ?? [],
    current: () => current,
    inAppChoice: true,
    set(lang) {
      if (lang === current) return
      current = lang
      prefs.set('lang', lang)
      for (const l of [...listeners]) l()
    },
    openSystemSettings: async () => false,
    subscribe(cb) {
      listeners.add(cb)
      return () => listeners.delete(cb)
    },
  }
}

/** The web camera scanner (html5-qrcode, legacy `ScanCode.tsx`) comes with the platform step
 *  (handover step 7). Until then the web reports no scanner, and the verify flow offers code entry. */
export const webScannerUnavailable: ScannerPort = {
  availability: async () => 'unsupported',
  permission: async () => 'prompt',
  scan: async () => ({ kind: 'error', message: 'scanner not available yet' }),
  openSettings: async () => undefined,
}

/** Foreground and background from the page's visibility (a Capacitor WebView reports it too; the
 *  native app state and the back button come with the platform step). */
export function webAppState(): { onState(cb: (s: 'active' | 'background') => void): () => void } {
  return {
    onState(cb) {
      if (typeof document === 'undefined') return () => undefined
      const on = () => cb(document.visibilityState === 'visible' ? 'active' : 'background')
      document.addEventListener('visibilitychange', on)
      return () => document.removeEventListener('visibilitychange', on)
    },
  }
}

export function createWebPlatform(): Platform {
  const prefs = webPrefs()
  return {
    clock: webClock,
    entropy: webEntropy,
    language: webLanguage(prefs),
    prefs,
    clipboard: webClipboard(webClock),
    screen: webScreenProtection(),
    scanner: webScannerUnavailable,
  }
}
