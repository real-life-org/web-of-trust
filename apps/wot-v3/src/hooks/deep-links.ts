// Card links the app is opened with (#489): the platform's DeepLinkPort (a cold start's launch URL
// once, then every URL that opens the running app), consumed by the shell once the holder is in use.
import { useEffect, useRef } from 'react'
import type { VerifyState } from '../flows/verify'
import { usePlatform } from './context'

/** whether the verify page can take a link now: not mounted yet, or still at its own card */
export function linkTakes(verify: VerifyState | null): boolean {
  return verify === null || verify.name === 'showing' || verify.name === 'ready'
}

export function useDeepLinks(onLink: (url: string) => void): void {
  const platform = usePlatform()
  const ref = useRef(onLink)
  useEffect(() => {
    ref.current = onLink
  })
  useEffect(() => {
    let live = true
    void platform.deepLinks.initial().then((url) => {
      if (live && url) ref.current(url)
    })
    const off = platform.deepLinks.subscribe((url) => ref.current(url))
    return () => {
      live = false
      off()
    }
  }, [platform])
}
