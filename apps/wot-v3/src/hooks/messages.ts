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
  const draftKey = useRef<string | null>(null)
  const tooLong = codePoints(text) > MAX_MESSAGE_CODE_POINTS
  const setText = useCallback(
    (next: string) => {
      setError(false)
      if (draftKey.current === null && next.trim() !== '') draftKey.current = platform.entropy.uuid()
      setTextState(next)
    },
    [platform],
  )
  const submit = useCallback(
    (body: string, dk: string) => {
      void port.trust.send(key, body, dk).done.then((r: Result<unknown>) => {
        // held refusals (not-ready, blocked, no-own-channel) keep the message in the conversation
        if (!r.ok && !(r.error.kind === 'refused' && ['not-ready', 'contact-blocked', 'not-possible-yet'].includes(r.error.code))) setError(true)
      })
    },
    [port, key],
  )
  return {
    text,
    tooLong,
    error,
    setText,
    send() {
      const body = text.trim()
      if (body === '' || tooLong) return
      const dk = draftKey.current ?? platform.entropy.uuid()
      draftKey.current = null
      setTextState('')
      submit(body, dk)
    },
    resend(body) {
      submit(body, platform.entropy.uuid())
    },
  }
}
