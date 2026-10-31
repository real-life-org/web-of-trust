// Card links the app is opened with (#489, #491): the platform's DeepLinkPort (a cold start's launch
// URL once, then every URL that opens the running app) feeds an inbox that lives as long as the app,
// also while the identity is locked and the shell is not mounted. The shell takes the links out once
// it is up, one at a time.
import { useEffect } from 'react'
import type { ReadStore } from '../port'
import { writableStore } from '../port/store'
import type { VerifyState } from '../flows/verify'
import type { Platform } from '../platform/ports'

/** the links received and not yet taken, oldest first */
export interface LinkInbox extends ReadStore<readonly string[]> {
  push(url: string): void
  /** a link given back by the session (its check could not finish): first in line again */
  putBack(url: string): void
  /** the oldest link, removed; null when there is none */
  take(): string | null
}

export function createLinkInbox(): LinkInbox {
  const store = writableStore<readonly string[]>([])
  return {
    get: store.get,
    subscribe: store.subscribe,
    push(url) {
      store.set([...store.get(), url])
    },
    putBack(url) {
      store.set([url, ...store.get()])
    },
    take() {
      const [first, ...rest] = store.get()
      if (first === undefined) return null
      store.set(rest)
      return first
    },
  }
}

/** Collects the platform's deep links into the inbox for the app's lifetime (App.tsx). The launch URL
 *  is pushed whenever it arrives, also after an effect replay (StrictMode): the port hands it out once,
 *  so the first call's answer must not be dropped. */
export function useLinkCollector(platform: Pick<Platform, 'deepLinks'>, inbox: LinkInbox): void {
  useEffect(() => {
    void platform.deepLinks.initial().then((url) => {
      if (url) inbox.push(url)
    })
    return platform.deepLinks.subscribe((url) => inbox.push(url))
  }, [platform, inbox])
}

/** whether the verify page can take a link now: not mounted yet, or still at its own card */
export function linkTakes(verify: VerifyState | null): boolean {
  return verify === null || verify.name === 'showing' || verify.name === 'ready'
}
