// Web implementations of the platform ports (architecture §5).

import type { ClockPort, EntropyPort, Language, LanguagePort, MailPort, Platform, PrefsPort, ScannerPort, SharePort } from '../ports'
import { webClipboard, webScreenProtection } from './identity'
import { liveUpdateOff, webDeepLinks, webLifecycle } from './lifecycle'
import { webScanner } from './scanner'

export * from './identity'
export { backHandlers, isCardLink, liveUpdateOff, webDeepLinks, webLifecycle } from './lifecycle'
export { scanFailure, webScanner, type QrEngine, type QrEngineFactory } from './scanner'

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

/** No camera scanner (a platform without one): the verify flow offers code entry. */
export const webScannerUnavailable: ScannerPort = {
  availability: async () => 'unsupported',
  permission: async () => 'prompt',
  scan: async () => ({ kind: 'error', message: 'camera-unavailable' }),
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

export function createWebPlatform(): Platform {
  const prefs = webPrefs()
  return {
    clock: webClock,
    entropy: webEntropy,
    language: webLanguage(prefs),
    prefs,
    clipboard: webClipboard(webClock),
    screen: webScreenProtection(),
    scanner: webScanner(),
    mail: webMail,
    share: webShare,
    lifecycle: webLifecycle(),
    deepLinks: webDeepLinks(),
    liveUpdate: liveUpdateOff,
  }
}
