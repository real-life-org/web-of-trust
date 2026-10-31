// The life of a card link in the app (#489, #491, #492). Three owners, each with a clear end:
//
// 1. The app-wide inbox (hooks/deep-links.ts) owns every link not yet accepted. It lives as long as
//    the app, also through a lock. A link the session could not finish checking goes back to it.
// 2. The shell session owns accepted jobs: the check of a link and its hand-over. It begins with
//    `activate()` (the shell's effect setup) and ends with `deactivate()` (its cleanup: a lock, a
//    switch, an effect replay). Its end kills every result still in flight at once: an unchecked link
//    returns to the inbox, a link handed to a page but not taken is discarded. A later session may
//    accept new jobs; nothing revives an old result. No timers, no guess whether a cleanup is final.
// 3. The verify page owns the link handed to it. Its end (`viewEnded`: the verify route left the
//    stack) ends that ownership for good; a check started on one page dies with that page, also when
//    the page is opened again before the result comes (pages are counted by `pageOpened`).
//
// Rules on top: one link at a time (a further one is refused with the message, never dropped, never
// replacing it); a verification past its own card is not interrupted (checked when the link arrives
// and again right before the hand-over); a link that is no card leaves the app where it is, with the
// message. Pure, no React: the shell gives what it reads and what it does.
import type { CardPreview, Result } from '../port'
import type { VerifyState } from '../flows/verify'
import { linkTakes } from '../hooks'

export interface LinkJobDeps {
  preview(url: string): Promise<Result<CardPreview>>
  /** the route on top of the stack, now */
  onVerify(): boolean
  openVerify(): void
  /** the pending link for the verify page (null: none) */
  setPending(url: string | null): void
  /** a link whose check the session could not finish goes back to the inbox, first in line */
  requeue(url: string): void
  refusedBusy(): void
  refusedUnusable(): void
}

export interface LinkJobs {
  /** the session begins: jobs are accepted from now on */
  activate(): void
  /** the session ends: results in flight are dead, an unchecked link returns to the inbox, a pending link is discarded */
  deactivate(): void
  /** a link from the inbox; outside a session it goes straight back */
  offer(url: string): void
  /** the verify page took the pending link */
  taken(): void
  /** the verify route came on top: a page of its own */
  pageOpened(): void
  /** the verify route left the stack: the page ended */
  viewEnded(): void
  /** the verify page's state as it changes (null while it is not mounted) */
  verifyState(s: VerifyState | null): void
  /** the pending link, for tests */
  pending(): string | null
}

export function createLinkJobs(deps: LinkJobDeps): LinkJobs {
  /** the session: 0 none; every activation a new number, a result of another session is dead */
  let session = 0
  let active = false
  /** the check in flight: its url and the session and page it belongs to; null: none */
  let check: { readonly url: string; readonly session: number; readonly page: number | null } | null = null
  let pending: string | null = null
  let verify: VerifyState | null = null
  let pages = 0
  const setPending = (url: string | null) => {
    pending = url
    deps.setPending(url)
  }
  return {
    activate() {
      session += 1
      active = true
    },
    deactivate() {
      active = false
      if (check !== null) {
        const { url } = check
        check = null
        deps.requeue(url)
      }
      if (pending !== null) setPending(null)
    },
    offer(url) {
      if (!active) {
        deps.requeue(url)
        return
      }
      if (pending !== null || check !== null || (deps.onVerify() && !linkTakes(verify))) {
        deps.refusedBusy()
        return
      }
      const mine = { url, session, page: deps.onVerify() ? pages : null }
      check = mine
      void deps.preview(url).then((preview) => {
        // the session ended, or the result is nobody's any more
        if (check !== mine || mine.session !== session || !active) return
        check = null
        if (!preview.ok) {
          deps.refusedUnusable()
          return
        }
        // the page the check belonged to ended (owner 3)
        if (mine.page !== null && (pages !== mine.page || !deps.onVerify())) return
        // checked again right before the hand-over
        if (deps.onVerify() && !linkTakes(verify)) {
          deps.refusedBusy()
          return
        }
        setPending(url)
        if (!deps.onVerify()) deps.openVerify()
      })
    },
    taken() {
      setPending(null)
    },
    pageOpened() {
      pages += 1
    },
    verifyState(s) {
      verify = s
    },
    viewEnded() {
      // a check started on this page dies with it; a pending link is discarded
      if (check !== null && check.page !== null) check = null
      if (pending !== null) setPending(null)
    },
    pending: () => pending,
  }
}
