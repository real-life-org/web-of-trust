// @vitest-environment node
// The life of a card link (src/app/link-job.ts, #489/#491/#492): one job owns check and hand-over;
// one link at a time; a verification past its own card is not interrupted; the end of the responsible
// view invalidates every outstanding result; a link that is no card leaves the app where it is.
import { describe, expect, it } from 'vitest'
import { createLinkJobs, type LinkJobDeps } from '../src/app/link-job'
import type { CardPreview, Result } from '../src/port'
import type { VerifyState } from '../src/flows/verify'

const PREVIEW: CardPreview = { role: 'displayed', name: 'Zelda', knownContact: null, self: false }
const base = { run: 1, card: null, mutual: [] }
const READY = { ...base, name: 'ready', hint: null } as VerifyState
const WAITING = { ...base, name: 'waiting', contactId: 'c1', name2: null, waitLong: false } as unknown as VerifyState

function world() {
  const log: string[] = []
  const answers: ((r: Result<CardPreview>) => void)[] = []
  const w = { onVerify: false, pending: null as string | null }
  const deps: LinkJobDeps = {
    preview: () => new Promise((resolve) => answers.push(resolve)),
    onVerify: () => w.onVerify,
    openVerify: () => log.push('open'),
    setPending: (url) => {
      w.pending = url
      log.push(`pending ${url}`)
    },
    refusedBusy: () => log.push('busy'),
    refusedUnusable: () => log.push('unusable'),
  }
  const jobs = createLinkJobs(deps)
  const answer = async (ok = true) => {
    answers.shift()?.(ok ? { ok: true, value: PREVIEW } : { ok: false, error: { kind: 'refused', code: 'card-invalid' } })
    await new Promise((r) => setTimeout(r, 0))
  }
  return { jobs, log, answer, w, outstanding: () => answers.length }
}

describe('link jobs', () => {
  it('from the list: checked, then handed over and the verify route opened', async () => {
    const { jobs, log, answer } = world()
    jobs.offer('u1')
    await answer()
    expect(log).toEqual(['pending u1', 'open'])
  })

  it('on the verify page at its own card: handed over without opening', async () => {
    const { jobs, log, answer, w } = world()
    w.onVerify = true
    jobs.pageOpened()
    jobs.verifyState(READY)
    jobs.offer('u1')
    await answer()
    expect(log).toEqual(['pending u1'])
    jobs.taken()
    expect(jobs.pending()).toBeNull()
  })

  it('one at a time: a second link while one is checked or pending is refused, never previewed', async () => {
    const { jobs, log, answer, w, outstanding } = world()
    jobs.offer('u1')
    jobs.offer('u2')
    expect(log).toEqual(['busy'])
    expect(outstanding()).toBe(1)
    await answer()
    expect(w.pending).toBe('u1')
    jobs.offer('u3')
    expect(log.at(-1)).toBe('busy')
  })

  it('a verification past its own card is not interrupted: refused when the link arrives, and again right before the hand-over', async () => {
    const { jobs, log, answer, w } = world()
    w.onVerify = true
    jobs.pageOpened()
    jobs.verifyState(WAITING)
    jobs.offer('u1')
    expect(log).toEqual(['busy'])
    // at the own card when the link arrives, past it when the check answers
    jobs.verifyState(READY)
    jobs.offer('u2')
    jobs.verifyState(WAITING)
    await answer()
    expect(log).toEqual(['busy', 'busy'])
    expect(w.pending).toBeNull()
  })

  it('#492: the verify page ends during the check: the late result opens nothing', async () => {
    const { jobs, log, answer, w } = world()
    w.onVerify = true
    jobs.pageOpened()
    jobs.verifyState(READY)
    jobs.offer('u1')
    // closed: the page is gone, the list is on top
    w.onVerify = false
    jobs.verifyState(null)
    jobs.viewEnded()
    await answer()
    expect(log).toEqual([])
    // the next link is not held up by the dead check
    jobs.offer('u2')
    await answer()
    expect(log).toEqual(['pending u2', 'open'])
  })

  it('#492: the page is opened again before the result comes: the result still belongs to the ended page', async () => {
    const { jobs, log, answer, w } = world()
    w.onVerify = true
    jobs.pageOpened()
    jobs.verifyState(READY)
    jobs.offer('u1')
    jobs.verifyState(null)
    jobs.viewEnded()
    jobs.pageOpened()
    jobs.verifyState(READY)
    await answer()
    expect(log).toEqual([])
  })

  it('a check started from the list survives navigation elsewhere, since no page of it ended', async () => {
    const { jobs, log, answer, w } = world()
    jobs.offer('u1')
    w.onVerify = false
    await answer()
    expect(log).toEqual(['pending u1', 'open'])
  })

  it('the page ends while a link is pending: the link is discarded', async () => {
    const { jobs, log, answer, w } = world()
    w.onVerify = true
    jobs.pageOpened()
    jobs.verifyState(READY)
    jobs.offer('u1')
    await answer()
    expect(w.pending).toBe('u1')
    jobs.viewEnded()
    expect(w.pending).toBeNull()
    expect(log).toEqual(['pending u1', 'pending null'])
  })

  it('no card: the message, the app stays where it is', async () => {
    const { jobs, log, answer } = world()
    jobs.offer('u1')
    await answer(false)
    expect(log).toEqual(['unusable'])
  })

  it('the owner ends during the check (dispose): the late result does nothing, nothing of the job acts again', async () => {
    const { jobs, log, answer, w } = world()
    jobs.offer('u1')
    jobs.dispose()
    await answer()
    expect(log).toEqual([])
    jobs.offer('u2')
    expect(log).toEqual([])
    expect(w.pending).toBeNull()
  })
})
