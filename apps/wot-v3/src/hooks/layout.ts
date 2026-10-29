// The viewport class the shell is laid out for (app/layout.ts decides what follows from it).
import { useSyncExternalStore } from 'react'

function mediaQuery(query: string): MediaQueryList | null {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function' ? window.matchMedia(query) : null
}

/** true while `query` matches (e.g. the shell's column breakpoint); false where there is no matchMedia */
export function useMediaQuery(query: string): boolean {
  return useSyncExternalStore(
    (onChange) => {
      const mq = mediaQuery(query)
      if (!mq) return () => {}
      mq.addEventListener('change', onChange)
      return () => mq.removeEventListener('change', onChange)
    },
    () => mediaQuery(query)?.matches ?? false,
    () => false,
  )
}
