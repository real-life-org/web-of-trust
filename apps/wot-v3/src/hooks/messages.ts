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
  /** a text whose send was not taken (the journal could not be written) while the composer holds a
   *  second text by then: kept here until it goes back into the field (review 421 R1-2, 20.10.) */
  readonly unsent: string | null
  restoreUnsent(): void
  setText(text: string): void
  /** sends the draft; the composer empties once the journal holds it (20.10.), the message shows
   *  from the journal; a send the journal did not take leaves the text in the field */
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
  /** the same list, readable from a send's answer without waiting for a render */
  const unsentRef = useRef<readonly { seq: number; text: string; key: string }[]>([])
  /** the order of the send gestures: what comes back keeps it, whatever order the answers take (R4-3) */
  const seq = useRef(0)
  // the composer's content as of now, beside the render state: a second tap in the same frame finds
  // it already handed over (review 421 R1-6)
  const live = useRef('')
  const draftKey = useRef<string | null>(null)
  /** returned texts that make up the untouched field, each with its gesture's place (R5-4, R6-2) */
  const inField = useRef<{ parts: readonly { seq: number; text: string }[]; text: string } | null>(null)
  /** the field's text handed to the command service, until the journal answers */
  const pending = useRef<{ text: string; key: string } | null>(null)
  const tooLong = codePoints(text) > MAX_MESSAGE_CODE_POINTS
  const setText = useCallback(
    (next: string) => {
      setError(false)
      live.current = next
      inField.current = null
      // a text other than the one waiting for the journal is a message of its own: its own key
      const p = pending.current
      if (p && draftKey.current === p.key && next.trim() !== p.text) draftKey.current = next.trim() === '' ? null : platform.entropy.uuid()
      if (draftKey.current === null && next.trim() !== '') draftKey.current = platform.entropy.uuid()
      setTextState(next)
    },
    [platform],
  )
  const submit = useCallback(
    (body: string, dk: string, fromField: boolean, n: number) => {
      const h = port.trust.send(key, body, dk)
      if (fromField) pending.current = { text: body, key: dk }
      // held refusals and an open outcome keep the message in the conversation: the text is taken
      const kept = (r: Result<unknown>) =>
        r.ok ||
        (r.error.kind === 'refused' && ['not-ready', 'contact-blocked', 'not-possible-yet'].includes(r.error.code)) ||
        (r.error.kind === 'infra' && r.error.code === 'unknown-outcome')
      const taken = h.journaled ?? h.done.then(kept)
      void taken.then((ok) => {
        if (fromField && pending.current?.key === dk) pending.current = null
        const still = live.current.trim() === body && draftKey.current === dk
        if (ok) {
          // the journal holds the text: the field empties, unless it holds a second text by now
          if (fromField && still) {
            live.current = ''
            draftKey.current = null
            inField.current = null
            setTextState('')
            // what waited beside this text goes back into the now empty field (421 R9-5)
            if (unsentRef.current.length > 0) {
              const back = unsentRef.current
              const next = back.map((u) => u.text).join('\n')
              live.current = next
              draftKey.current = back.length === 1 ? back[0]!.key : platform.entropy.uuid()
              inField.current = { parts: back.map((u) => ({ seq: u.seq, text: u.text })), text: next }
              unsentRef.current = []
              setUnsent([])
              setTextState(next)
            }
          }
          return
        }
        setError(true)
        // not taken: the text stays in the field; only when a second text stands there by now does it
        // wait beside it, "Not sent: … / Back into the field" (review 421 R1-2, 20.10.)
        if (!fromField) return
        if (still) {
          // it stays in the field with its gesture's place, for texts that come back later (R7)
          inField.current = { parts: [{ seq: n, text: body }], text: live.current }
          return
        }
        if (live.current === '') {
          // the field is empty by now (a later text went out): the text goes back into it (421 R8-5)
          live.current = body
          draftKey.current = dk
          inField.current = { parts: [{ seq: n, text: body }], text: body }
          setTextState(body)
          return
        }
        unsentRef.current = [...unsentRef.current, { seq: n, text: body, key: dk }].sort((a, b) => a.seq - b.seq)
        setUnsent(unsentRef.current)
      })
    },
    [port, key, platform],
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
      const placed = inField.current && inField.current.text === live.current ? inField.current.parts : null
      const back = [...unsent, ...(placed ?? [])].sort((a, b) => a.seq - b.seq)
      // a field text still waiting for its journal stays with its send: taken, it is gone; not taken,
      // it comes back here like the others (20.10.)
      const typed = pending.current && live.current.trim() === pending.current.text ? '' : live.current
      const next = [...back.map((u) => u.text), placed ? '' : typed].filter((x) => x !== '').join('\n')
      const only = unsent.length === 1 && typed === '' ? unsent[0] : null
      // the field is made of returned texts only: it keeps their places for the next return
      inField.current = placed || typed === '' ? { parts: back.map((u) => ({ seq: u.seq, text: u.text })), text: next } : null
      live.current = next
      draftKey.current = only ? only.key : platform.entropy.uuid()
      setTextState(next)
      unsentRef.current = []
      setUnsent([])
    },
    setText,
    send() {
      const body = live.current.trim()
      if (body === '' || codePoints(body) > MAX_MESSAGE_CODE_POINTS) return
      // the same text already waits for its journal: the second tap is the same gesture
      if (pending.current?.text === body && pending.current.key === draftKey.current) return
      const dk = draftKey.current ?? platform.entropy.uuid()
      draftKey.current = dk
      inField.current = null
      submit(body, dk, true, ++seq.current)
    },
    resend(body) {
      submit(body, platform.entropy.uuid(), false, ++seq.current)
    },
  }
}
