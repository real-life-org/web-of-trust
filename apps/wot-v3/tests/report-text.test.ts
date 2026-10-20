// The report mail (paper §6): transcript lines, the mailto body limit, the attachment above it.
import { describe, expect, it } from 'vitest'
import { MAILTO_BODY_LIMIT, REPORT_ADDRESS, reportMail, transcript, type ReportMessage } from '../src/lib/report'

const labels = { sent: (t: string) => `sent ${t}`, received: (t: string) => `received ${t}`, heading: 'Web of Trust · times in America/Los_Angeles' }
const time = (at: number) => new Date(at).toISOString().slice(11, 16)
const msg = (text: string, mine = false): ReportMessage => ({ mine, author: mine ? 'Me' : 'Noah Lindqvist', sentAt: Date.UTC(2026, 9, 15, 20, 34), receivedAt: Date.UTC(2026, 9, 15, 20, 35), text })

describe('report mail', () => {
  it('lists direction, sender time, arrival and text; own messages without arrival', () => {
    expect(transcript([msg('hello'), msg('hi', true)], time, labels)).toBe(
      'Web of Trust · times in America/Los_Angeles\n\nNoah Lindqvist (sent 20:34, received 20:35):\nhello\n\nMe (sent 20:34):\nhi\n',
    )
  })

  it('keeps a short transcript in the body, addressed to the publisher', () => {
    const m = reportMail({ subject: 'Report', intro: 'I report.', introAttached: 'I report, attached.', transcript: 'short', fileName: 'report.txt' })
    expect(m).toMatchObject({ to: REPORT_ADDRESS, body: 'I report.\n\nshort', file: null, full: 'I report.\n\nshort' })
  })

  it('above the mailto limit the transcript goes as a file, the body keeps the standard text', () => {
    const long = transcript(Array.from({ length: 20 }, (_, i) => msg(`message ${i} `.repeat(20))), time, labels)
    const m = reportMail({ subject: 'Report', intro: 'I report.', introAttached: 'I report. The conversation is attached.', transcript: long, fileName: 'report.txt' })
    expect(encodeURIComponent(`I report.\n\n${long}`).length).toBeGreaterThan(MAILTO_BODY_LIMIT)
    expect(m.body).toBe('I report. The conversation is attached.')
    expect(m.file).toEqual({ name: 'report.txt', text: long })
    expect(m.full).toContain('message 19')
  })
})
