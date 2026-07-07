import { useCallback, useEffect, useRef } from 'react'
import { useAdapters } from '../context'
import { isDidcommMessage } from '@web_of_trust/core/protocol'
import type { MessageEnvelope } from '@web_of_trust/core/types'

export function useMessaging() {
  const { messaging, messagingState } = useAdapters()
  const callbacksRef = useRef<Set<(envelope: MessageEnvelope) => void | Promise<void>>>(new Set())

  // Single onMessage subscription that dispatches to all registered callbacks.
  // VE-1: die DIDComm-Inbox-Familie gehört dem InboxReceptionHost bzw.
  // Replication-Adapter — dieser Hook reicht nur den Old-World-Kanal weiter.
  useEffect(() => {
    const unsubscribe = messaging.onMessage(async (message) => {
      if (isDidcommMessage(message)) return
      const envelope = message as MessageEnvelope
      for (const cb of callbacksRef.current) {
        try {
          await cb(envelope)
        } catch (err) {
          console.error('Message callback error:', err)
        }
      }
    })
    return unsubscribe
  }, [messaging])

  const onMessage = useCallback((callback: (envelope: MessageEnvelope) => void | Promise<void>) => {
    callbacksRef.current.add(callback)
    return () => {
      callbacksRef.current.delete(callback)
    }
  }, [])

  const send = useCallback(
    (envelope: MessageEnvelope) => messaging.send(envelope),
    [messaging],
  )

  return {
    send,
    onMessage,
    state: messagingState,
    isConnected: messagingState === 'connected',
  }
}
