// @vitest-environment node
// Report and block (paper §6, architecture §4.2 "Melden" as replaced by the mail draft): every row of
// the report table over two loopback devices on the real library, with the fake mail app, share sheet
// and clipboard of the platform.
import { describe, expect, it } from 'vitest'
import type { ContactId, MessageItem } from '../../src/port'
import { secret } from '../../src/port'
import { virtualClock, type FakeMail, type FakeShare } from '../../src/platform/fake'
import { reportMachine, reportStart, REPORT_TABLE, MAX_SELECTED, type ReportState } from '../../src/flows/report'
import { createFlowRunner } from '../../src/hooks/flow-runner'
import { reportExecutor } from '../../src/hooks/report'
import { reportMail, transcript, REPORT_ADDRESS } from '../../src/lib/report'
import { LOOPBACK_PHRASES, loopbackDevice, memoryCarrier, type LoopbackDevice } from '../../harness/loopback'
import { drive, tableCoverage } from './world'

const cover = tableCoverage('report', REPORT_TABLE)
const T0 = Date.parse('2026-10-15T13:30:00-07:00')

async function met(n = 2) {
  const carrier = memoryCarrier()
  const clock = virtualClock(T0, 'America/Los_Angeles')
  const A = await loopbackDevice({ carrier, id: 'A', name: 'Al', words: LOOPBACK_PHRASES[0], clock, seed: 51 })
  const B = await loopbackDevice({ carrier, id: 'B', name: 'Bea', words: LOOPBACK_PHRASES[1], clock, seed: 53 })
  const settle = async () => {
    for (let i = 0; i < 5; i++) {
      await carrier.settled()
      await A.port.session()?.idle()
      await B.port.session()?.idle()
    }
  }
  const shown = await B.port.trust.showCard().done
  if (!shown.ok) throw new Error('show')
  await A.port.trust.confirmCard(shown.value.qr).done
  await settle()
  const v = B.port.stores.contacts.get()
  const bId = (v.status === 'ready' ? v.value[0]?.id : undefined) as ContactId
  await B.port.trust.counterVerify(bId).done
  await settle()
  const a = A.port.stores.contacts.get()
  const aId = (a.status === 'ready' ? a.value[0]?.id : undefined) as ContactId
  for (let i = 0; i < n; i++) {
    clock.advance(60_000)
    await A.port.trust.send(`c:${aId}`, `unwanted message ${i}`, `d${i}`).done
  }
  await settle()
  return { A, B, aId, bId, settle }
}

function messagesOf(d: LoopbackDevice, id: ContactId): MessageItem[] {
  const c = d.port.stores.conversation(`c:${id}`).get()
  return c.status === 'ready' ? c.value.items.filter((i): i is MessageItem => i.kind === 'message') : []
}

const mailFor = (msgs: readonly MessageItem[], ids: readonly string[]) =>
  reportMail({
    subject: 'Report',
    intro: 'I report.',
    introAttached: 'I report, attached.',
    transcript: transcript(
      msgs.filter((m) => ids.includes(m.id)).map((m) => ({ mine: false, author: 'Al', sentAt: m.at, receivedAt: m.receivedAt ?? null, text: m.text })),
      (at) => new Date(at).toISOString(),
      { sent: (t) => `sent ${t}`, received: (t) => `received ${t}`, heading: 'Web of Trust' },
    ),
    fileName: 'report.txt',
  })

function runner(d: LoopbackDevice, contactId: ContactId, preselected: readonly string[]) {
  return cover.track(createFlowRunner(reportMachine(contactId), reportStart(preselected), reportExecutor(d.port, d.platform), d.platform))
}

describe('report transitions', () => {
  it('notice, choice, review; confirming blocks and opens the mail draft; done goes to the conversation', async () => {
    const w = await met(3)
    const msgs = messagesOf(w.B, w.bId)
    expect(msgs).toHaveLength(3)
    const r = runner(w.B, w.bId, msgs.map((m) => m.id))
    expect(r.get()).toMatchObject({ name: 'info', selected: msgs.map((m) => m.id) })
    await drive(r, { type: 'next' }, { type: 'back' }, { type: 'next' })
    await drive(r, { type: 'toggle', id: msgs[0]!.id })
    expect((r.get() as Extract<ReportState, { name: 'selecting' }>).selected).toHaveLength(2)
    await drive(r, { type: 'toggle', id: msgs[0]!.id }, { type: 'next' }, { type: 'back' }, { type: 'next' })
    expect(r.get().name).toBe('review')
    const mail = mailFor(msgs, msgs.map((m) => m.id))
    await drive(r, { type: 'confirm', mail })
    expect(r.get().name).toBe('handedOver')
    const fake = w.B.platform.mail as FakeMail
    expect(fake.drafts).toEqual([{ to: REPORT_ADDRESS, subject: 'Report', body: mail.body }])
    expect(fake.drafts[0]?.body).toContain('unwanted message 2')
    // the block went through the real library: blocked and paused, nothing shown
    const c = w.B.port.stores.contacts.get()
    expect(c.status === 'ready' && c.value[0]).toMatchObject({ blocked: true, trust: { paused: true } })
    await drive(r, { type: 'openMail' })
    expect(fake.drafts).toHaveLength(2)
    await drive(r, { type: 'done' })
    expect(r.get()).toMatchObject({ name: 'exit', to: 'chat' })
  })

  it('at most twenty messages; the notice can be left; no messages, no review', async () => {
    const w = await met(1)
    const ids = Array.from({ length: 25 }, (_, i) => `m${i}`)
    const r = runner(w.B, w.bId, ids)
    expect((r.get() as Extract<ReportState, { name: 'info' }>).selected).toEqual(ids.slice(-MAX_SELECTED))
    await drive(r, { type: 'next' }, { type: 'toggle', id: 'm0' })
    expect((r.get() as Extract<ReportState, { name: 'selecting' }>).selected).toHaveLength(MAX_SELECTED)
    for (const id of ids.slice(-MAX_SELECTED)) r.send({ type: 'toggle', id })
    await drive(r, { type: 'next' })
    expect(r.get().name).toBe('selecting')
    const r2 = runner(w.B, w.bId, [])
    await drive(r2, { type: 'back' })
    expect(r2.get()).toMatchObject({ name: 'exit', to: 'back' })
  })

  it('no mail app: address and text to copy; the mail app can be tried again; done without a report', async () => {
    const w = await met(2)
    const msgs = messagesOf(w.B, w.bId)
    const fake = w.B.platform.mail as FakeMail
    fake.available = false
    const r = runner(w.B, w.bId, msgs.map((m) => m.id))
    await drive(r, { type: 'next' }, { type: 'next' }, { type: 'confirm', mail: mailFor(msgs, msgs.map((m) => m.id)) })
    expect(r.get().name).toBe('fallback')
    await drive(r, { type: 'copy', what: 'address' })
    expect(r.get()).toMatchObject({ copied: 'address', copyFailed: false })
    expect(w.B.device.clipboard.text).toBe(REPORT_ADDRESS)
    await drive(r, { type: 'copy', what: 'text' })
    expect(w.B.device.clipboard.text).toContain('unwanted message 1')
    await drive(r, { type: 'openMail' })
    expect(r.get().name).toBe('fallback')
    fake.available = true
    await drive(r, { type: 'openMail' })
    expect(r.get().name).toBe('handedOver')
    await drive(r, { type: 'noMailApp' }, { type: 'done' })
    expect(r.get()).toMatchObject({ name: 'exit', to: 'chat' })
  })

  it('a long transcript goes as a file through the share sheet; without file sharing the copy fallback', async () => {
    const w = await met(1)
    const long = Array.from({ length: 20 }, (_, i) => ({ kind: 'message', id: `x${i}`, at: T0 + i, receivedAt: T0 + i, text: `a long message ${i} `.repeat(15) }) as unknown as MessageItem)
    const mail = mailFor(long, long.map((m) => m.id))
    expect(mail.file).not.toBeNull()
    const share = w.B.platform.share as FakeShare
    const r = runner(w.B, w.bId, ['x'])
    await drive(r, { type: 'next' }, { type: 'next' }, { type: 'confirm', mail })
    expect(r.get().name).toBe('handedOver')
    expect(share.shared).toEqual([{ kind: 'file', name: 'report.txt', text: mail.file?.text, body: mail.body }])
    share.files = false
    await drive(r, { type: 'openMail' })
    expect(r.get().name).toBe('fallback')
    await drive(r, { type: 'done' })
  })

  it('the block fails while locked: nothing sent; retry after unlocking; or leave', async () => {
    const w = await met(1)
    const msgs = messagesOf(w.B, w.bId)
    await w.B.port.runtime.lock('user')
    const r = runner(w.B, w.bId, msgs.map((m) => m.id))
    await drive(r, { type: 'next' }, { type: 'next' }, { type: 'confirm', mail: mailFor(msgs, msgs.map((m) => m.id)) })
    expect(r.get().name).toBe('blockFailed')
    expect((w.B.platform.mail as FakeMail).drafts).toEqual([])
    await w.B.port.runtime.unlock.passphrase(secret('harness passphrase'))
    await w.B.port.runtime.unlock.open()
    await drive(r, { type: 'retry' })
    expect(r.get().name).toBe('handedOver')
    // a second report of a blocked contact: the block is already there
    const r2 = runner(w.B, w.bId, msgs.map((m) => m.id))
    await w.B.port.runtime.lock('user')
    await drive(r2, { type: 'next' }, { type: 'next' }, { type: 'confirm', mail: mailFor(msgs, []) })
    expect(r2.get().name).toBe('blockFailed')
    await drive(r2, { type: 'back' })
    expect(r2.get()).toMatchObject({ name: 'exit', to: 'back' })
  })
})
