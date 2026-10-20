// Web implementations of the platform ports (architecture §5). Only the ports the scaffold needs.

import type { ClockPort, EntropyPort, Language, LanguagePort, MailPort, Platform, PrefsPort, ScannerPort, SharePort } from '../ports'
import { webClipboard, webScreenProtection } from './identity'

export * from './identity'

export const webClock: ClockPort = {
  now: () => Date.now(),
  setTimer(at, cb) {
    const id = setTimeout(cb, Math.max(0, at - Date.now()))
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

/** mailto: opens the mail app; a browser cannot tell whether one exists, so the screen always
 *  offers the copy fallback next to it (paper §6 step 5). */
export const webMail: MailPort = {
  async compose({ to, subject, body }) {
    if (typeof document === 'undefined') return 'unavailable'
    const a = document.createElement('a')
    a.href = `mailto:${encodeURIComponent(to)}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`
    a.rel = 'noreferrer'
    a.click()
    return 'opened'
  },
}

/** Web Share API (text, and files where navigator.canShare allows them). */
export const webShare: SharePort = {
  async share({ text, url }) {
    if (typeof navigator === 'undefined' || !navigator.share) return 'unsupported'
    try {
      await navigator.share({ text, ...(url ? { url } : {}) })
      return 'shared'
    } catch (e) {
      return e instanceof DOMException && e.name === 'AbortError' ? 'cancelled' : 'unsupported'
    }
  },
  async shareFile({ name, text, title, body }) {
    if (typeof navigator === 'undefined' || !navigator.share || !navigator.canShare) return 'unsupported'
    const file = new File([text], name, { type: 'text/plain' })
    if (!navigator.canShare({ files: [file] })) return 'unsupported'
    try {
      await navigator.share({ files: [file], title, ...(body ? { text: body } : {}) })
      return 'shared'
    } catch (e) {
      return e instanceof DOMException && e.name === 'AbortError' ? 'cancelled' : 'unsupported'
    }
  },
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
    mail: webMail,
    share: webShare,
  }
}
