// The life of a card link in the app (#489, #491, #492): one job owns the check and the hand-over.
// Pure, no React: the shell gives it what it reads (route, verify state) and what it does (open the
// verify route, show a message, set the pending link).
//
// Rules:
// 1. One link at a time. While a link is pending (handed to the verify page, not taken yet) or being
//    checked, every further link is refused with the message, never dropped, never replacing it.
// 2. A verification past its own card is not interrupted: refused with the message, checked when the
//    link arrives and again right before the hand-over.
// 3. The end of the responsible view invalidates every outstanding result: a check started while the
//    verify page was open dies with that page (also if the page is opened again before the result
//    comes); a pending link is discarded when the page ends.
// 4. A link that is no card leaves the app where it is, with the message.
// 5. The end of the owner (the shell unmounts: a lock, a switch) disposes the job: the check in
//    flight is dead, the pending link discarded, and nothing of it ever reaches the next owner.
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
  refusedBusy(): void
  refusedUnusable(): void
}

export interface LinkJobs {
  /** a link from the inbox */
  offer(url: string): void
  /** the verify page took the pending link */
  taken(): void
  /** the verify route came on top: a page of its own (a check started on an earlier one dies with it) */
  pageOpened(): void
  /** the verify route left the stack: the page ended */
  viewEnded(): void
  /** the verify page's state as it changes (null while it is not mounted) */
  verifyState(s: VerifyState | null): void
  /** the owner ended: every outstanding result is dead, nothing of this job acts again */
  dispose(): void
  /** the pending link, for tests */
  pending(): string | null
}

export function createLinkJobs(deps: LinkJobDeps): LinkJobs {
  let pending: string | null = null
  /** the id of the check in flight (0: none); a job whose id is no longer current is dead */
  let checking = 0
  let ids = 0
  let verify: VerifyState | null = null
  let mounts = 0
  let disposed = false
  const setPending = (url: string | null) => {
    pending = url
    deps.setPending(url)
  }
  return {
    offer(url) {
      if (disposed) return
      if (pending !== null || checking !== 0 || (deps.onVerify() && !linkTakes(verify))) {
        deps.refusedBusy()
        return
      }
      const id = ++ids
      checking = id
      const startedOnVerify = deps.onVerify()
      const mount = mounts
      void deps.preview(url).then((preview) => {
        // cancelled or superseded meanwhile: the result is nobody's
        if (checking !== id) return
        checking = 0
        if (!preview.ok) {
          deps.refusedUnusable()
          return
        }
        // the page the check belonged to ended (rule 3)
        if (startedOnVerify && (mounts !== mount || !deps.onVerify())) return
        // checked again right before the hand-over (rule 2)
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
      mounts += 1
    },
    verifyState(s) {
      verify = s
    },
    viewEnded() {
      // a check started on this page dies with it; a pending link is discarded
      checking = 0
      if (pending !== null) setPending(null)
    },
    dispose() {
      disposed = true
      checking = 0
      pending = null
    },
    pending: () => pending,
  }
}
