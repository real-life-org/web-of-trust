// Native language (architecture §5 "Sprachregel"): the system per-app language is the source; the app
// has no own choice (`inAppChoice` false), the profile entry opens the system settings (Android 13+ app
// language, below that and on iOS the app's settings page). The WebView reports the per-app language
// in navigator.languages; it is read again whenever the app returns to the foreground.

import type { Language, LanguagePort, LifecyclePort } from '../ports'
import { openAppSettings } from './scanner'

function pick(candidates: readonly string[]): Language {
  for (const c of candidates) {
    const base = c.toLowerCase().split('-')[0]
    if (base === 'en' || base === 'de') return base
  }
  // an unknown system language is English (§5)
  return 'en'
}

export function capacitorLanguage(lifecycle: Pick<LifecyclePort, 'onState'>, system: () => readonly string[] = () => navigator.languages ?? []): LanguagePort {
  let current = pick(system())
  const listeners = new Set<() => void>()
  lifecycle.onState((s) => {
    if (s !== 'active') return
    const next = pick(system())
    if (next === current) return
    current = next
    for (const l of [...listeners]) l()
  })
  return {
    system,
    current: () => current,
    inAppChoice: false,
    // the system decides; an in-app choice does not exist natively
    set: () => undefined,
    openSystemSettings: () => openAppSettings(),
    subscribe(cb) {
      listeners.add(cb)
      return () => void listeners.delete(cb)
    },
  }
}
