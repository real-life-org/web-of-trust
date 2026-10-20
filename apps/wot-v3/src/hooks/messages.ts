// Writing in a conversation (architecture §4.1): the composer's draft with its draft key (the
// dedupe key of the send intent, one per composer content), the length bound of Message Tasks 3.2
// (1 to 4096 code points), and "send again as a new message" for a failed one (§2.7 N11).
import { useCallback, useRef, useState } from 'react'
import type { ConversationKey, Result } from '../port'
import { usePlatform, usePort } from './context'

export const MAX_MESSAGE_CODE_POINTS = 4096

export const codePoints = (text: string): number => [...text].length

export interface Draft {
  readonly text: string
  readonly tooLong: boolean
  readonly error: boolean
  /** a text whose send was not taken (the journal could not be written) while the composer already
   *  holds new text: kept here until it goes back into the field (review 421 R1-2) */
  readonly unsent: string | null
  restoreUnsent(): void
  setText(text: string): void
  /** sends the draft; the composer empties at once, the message shows from the journal */
  send(): void
  /** a new message with the text of a failed one */
  resend(text: string): void
}

export function useDraft(key: ConversationKey): Draft {
  const port = usePort()
  const platform = usePlatform()
  const [text, setTextState] = useState('')
  const [error, setError] = useState(false)
  // every text no durable step took, in the order it was sent, each with its draft key: a second
  // failure never replaces the first (review 421 R3-1)
  const [unsent, setUnsent] = useState<readonly { seq: number; text: string; key: string }[]>([])
  /** the order of the send gestures: what comes back keeps it, whatever order the answers take (R4-3) */
  const seq = useRef(0)
  // the composer's content as of now, beside the render state: a second tap in the same frame finds
  // it already handed over (review 421 R1-6)
  const live = useRef('')
  const draftKey = useRef<string | null>(null)
  /** a returned text put back into the empty field, while it is untouched: its gesture's place (R5-4) */
  const inField = useRef<{ seq: number; text: string } | null>(null)
  const tooLong = codePoints(text) > MAX_MESSAGE_CODE_POINTS
  const setText = useCallback(
    (next: string) => {
      setError(false)
      live.current = next
      inField.current = null
      if (draftKey.current === null && next.trim() !== '') draftKey.current = platform.entropy.uuid()
      setTextState(next)
    },
    [platform],
  )
  const submit = useCallback(
    (body: string, dk: string, restore: boolean, n: number) => {
      void port.trust.send(key, body, dk).done.then((r: Result<unknown>) => {
        if (r.ok) return
        const e = r.error
        // held refusals keep the message in the conversation; an unknown outcome is journaled
        if (e.kind === 'refused' && ['not-ready', 'contact-blocked', 'not-possible-yet'].includes(e.code)) return
        if (e.kind === 'infra' && e.code === 'unknown-outcome') return
        setError(true)
        // nothing durable took the text (journal not written): it goes back into an empty composer
        // with its draft key, or waits beside a composer that holds new text (review 421 R1-2)
        if (!restore) return
        if (live.current === '') {
          live.current = body
          draftKey.current = dk
          inField.current = { seq: n, text: body }
          setTextState(body)
        } else setUnsent((u) => [...u, { seq: n, text: body, key: dk }].sort((a, b) => a.seq - b.seq))
      })
    },
    [port, key],
  )
  return {
    text,
    tooLong,
    error,
    unsent: unsent.length === 0 ? null : unsent.map((u) => u.text).join('\n'),
    restoreUnsent() {
      if (unsent.length === 0) return
      // into the field in the order of the send gestures, before what was typed since; a returned text
      // still untouched in the field takes its gesture's place; a new key unless one text alone comes
      // back unchanged
      const placed = inField.current && inField.current.text === live.current ? inField.current : null
      const back = [...unsent, ...(placed ? [placed] : [])].sort((a, b) => a.seq - b.seq).map((u) => u.text)
      const next = [...back, placed ? '' : live.current].filter((x) => x !== '').join('\n')
      const only = unsent.length === 1 && live.current === '' ? unsent[0] : null
      inField.current = null
      live.current = next
      draftKey.current = only ? only.key : platform.entropy.uuid()
      setTextState(next)
      setUnsent([])
    },
    setText,
    send() {
      const body = live.current.trim()
      if (body === '' || codePoints(body) > MAX_MESSAGE_CODE_POINTS) return
      const dk = draftKey.current ?? platform.entropy.uuid()
      draftKey.current = null
      live.current = ''
      inField.current = null
      setTextState('')
      submit(body, dk, true, ++seq.current)
    },
    resend(body) {
      submit(body, platform.entropy.uuid(), false, ++seq.current)
    },
  }
}
