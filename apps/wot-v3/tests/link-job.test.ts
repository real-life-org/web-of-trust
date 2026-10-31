// @vitest-environment node
// The life of a card link (src/app/link-job.ts, #489/#491/#492): three owners. The inbox owns links
// not yet accepted; the shell session owns accepted jobs and its end kills their results at once (an
// unchecked link returns to the inbox); the verify page owns the link handed to it and its end is
// final. One link at a time; a verification past its own card is not interrupted; no card: the message.
import { describe, expect, it } from 'vitest'
import { createLinkJobs, type LinkJobDeps } from '../src/app/link-job'
import type { CardPreview, Result } from '../src/port'
import type { VerifyState } from '../src/flows/verify'

const PREVIEW: CardPreview = { role: 'displayed', name: 'Zelda', knownContact: null, self: false }
const base = { run: 1, card: null, mutual: [] }
const READY = { ...base, name: 'ready', hint: null } as VerifyState
const WAITING = { ...base, name: 'waiting', contactId: 'c1', name2: null, waitLong: false } as unknown as VerifyState

function world(opts: { active?: boolean } = {}) {
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
    requeue: (url) => log.push(`requeue ${url}`),
    refusedBusy: () => log.push('busy'),
    refusedUnusable: () => log.push('unusable'),
  }
  const jobs = createLinkJobs(deps)
  if (opts.active !== false) jobs.activate()
  const answer = async (ok = true) => {
    answers.shift()?.(ok ? { ok: true, value: PREVIEW } : { ok: false, error: { kind: 'refused', code: 'card-invalid' } })
    await new Promise((r) => setTimeout(r, 0))
  }
  /** the verify page: on top, a page of its own, at its own card */
  const onPage = () => {
    w.onVerify = true
    jobs.pageOpened()
    jobs.verifyState(READY)
  }
  return { jobs, log, answer, w, onPage, outstanding: () => answers.length }
}

describe('link jobs', () => {
  it('from the list: checked, then handed over and the verify route opened', async () => {
    const { jobs, log, answer } = world()
    jobs.offer('u1')
    await answer()
    expect(log).toEqual(['pending u1', 'open'])
  })

  it('on the verify page at its own card: handed over without opening; taken clears the pending link', async () => {
    const { jobs, log, answer, onPage } = world()
    onPage()
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
    const { jobs, log, answer, w, onPage } = world()
    onPage()
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

  it('no card: the message, the app stays where it is', async () => {
    const { jobs, log, answer } = world()
    jobs.offer('u1')
    await answer(false)
    expect(log).toEqual(['unusable'])
  })

  describe('owner 3, the verify page', () => {
    it('#492: the page ends during the check: the late result opens nothing; the next link is not held up', async () => {
      const { jobs, log, answer, w, onPage } = world()
      onPage()
      jobs.offer('u1')
      w.onVerify = false
      jobs.verifyState(null)
      jobs.viewEnded()
      await answer()
      expect(log).toEqual([])
      jobs.offer('u2')
      await answer()
      expect(log).toEqual(['pending u2', 'open'])
    })

    it('#492: the page is opened again before the result comes: the result still belongs to the ended page', async () => {
      const { jobs, log, answer, onPage } = world()
      onPage()
      jobs.offer('u1')
      jobs.verifyState(null)
      jobs.viewEnded()
      onPage()
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
      const { jobs, log, answer, w, onPage } = world()
      onPage()
      jobs.offer('u1')
      await answer()
      expect(w.pending).toBe('u1')
      jobs.viewEnded()
      expect(w.pending).toBeNull()
      expect(log).toEqual(['pending u1', 'pending null'])
    })
  })

  describe('owner 2, the shell session', () => {
    it('the session ends during the check: the link goes back to the inbox at once, the late result does nothing', async () => {
      const { jobs, log, answer } = world()
      jobs.offer('u1')
      jobs.deactivate()
      expect(log).toEqual(['requeue u1'])
      await answer()
      expect(log).toEqual(['requeue u1'])
    })

    it('a new session accepts new jobs; the old result stays dead even after the new session began', async () => {
      const { jobs, log, answer } = world()
      jobs.offer('u1')
      jobs.deactivate()
      jobs.activate()
      // the old check answers after the new session began
      await answer()
      expect(log).toEqual(['requeue u1'])
      jobs.offer('u1')
      await answer()
      expect(log).toEqual(['requeue u1', 'pending u1', 'open'])
    })

    it('the session ends while a link is pending: the link is discarded (the page is gone with the session)', async () => {
      const { jobs, log, answer, w, onPage } = world()
      onPage()
      jobs.offer('u1')
      await answer()
      expect(w.pending).toBe('u1')
      jobs.deactivate()
      expect(w.pending).toBeNull()
      expect(log).toEqual(['pending u1', 'pending null'])
    })

    it('outside a session a link goes straight back to the inbox', () => {
      const { jobs, log } = world({ active: false })
      jobs.offer('u1')
      expect(log).toEqual(['requeue u1'])
    })

    it('an effect replay (end and begin at once) loses no link: it returns and is checked under the new session', async () => {
      const { jobs, log, answer } = world()
      jobs.offer('u1')
      jobs.deactivate()
      jobs.activate()
      expect(log).toEqual(['requeue u1'])
      // the inbox offers it again
      jobs.offer('u1')
      await answer()
      await answer()
      expect(log).toEqual(['requeue u1', 'pending u1', 'open'])
    })
  })
})
