// The report mail (paper "Nachricht als Trust Task" §6): standard text, the selected messages as a
// transcript, the address of the publisher. Pure; the words come in as labels. What goes out: per
// message the direction (the name the reporter keeps for the contact, or "me"), the sender's time,
// the arrival, the text. Never anchors, MACs, other contacts or the origin of the relationship.

export const REPORT_ADDRESS = 'report@real-life.org'
export const MAX_REPORT_MESSAGES = 20
/** mailto: bodies are cut by mail apps at a few thousand characters, Android first: above this many
 *  encoded characters the transcript goes as a text file through the share sheet */
export const MAILTO_BODY_LIMIT = 2000

export interface ReportMessage {
  readonly mine: boolean
  /** the reporter's name for the contact (unchecked by anyone), or the "me" label for own messages */
  readonly author: string
  readonly sentAt: number
  readonly receivedAt: number | null
  readonly text: string
}

export interface ReportLabels {
  /** "sent {time}" */
  readonly sent: (time: string) => string
  /** "received {time}" */
  readonly received: (time: string) => string
  /** the head line of the transcript (app name, time zone) */
  readonly heading: string
}

export function transcript(messages: readonly ReportMessage[], time: (at: number) => string, l: ReportLabels): string {
  const lines = [l.heading, '']
  for (const m of messages) {
    const when = [l.sent(time(m.sentAt)), ...(m.receivedAt !== null && !m.mine ? [l.received(time(m.receivedAt))] : [])].join(', ')
    lines.push(`${m.author} (${when}):`, m.text, '')
  }
  return lines.join('\n').trimEnd() + '\n'
}

export interface ReportMail {
  readonly to: string
  readonly subject: string
  /** the mail body: standard text, and the transcript when it fits */
  readonly body: string
  /** the transcript as a file, when it does not fit into the body */
  readonly file: { readonly name: string; readonly text: string } | null
  /** everything, for the copy fallback without a mail app */
  readonly full: string
}

/** `intro` says "conversation below", `introAttached` "conversation attached" (paper §6 standard text). */
export function reportMail(opts: { subject: string; intro: string; introAttached: string; transcript: string; fileName: string }): ReportMail {
  const inline = `${opts.intro}\n\n${opts.transcript}`
  const fits = encodeURIComponent(inline).length + encodeURIComponent(opts.subject).length <= MAILTO_BODY_LIMIT
  return {
    to: REPORT_ADDRESS,
    subject: opts.subject,
    body: fits ? inline : opts.introAttached,
    file: fits ? null : { name: opts.fileName, text: opts.transcript },
    full: inline,
  }
}
