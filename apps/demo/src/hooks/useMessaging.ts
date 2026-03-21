import { useCallback, useEffect, useRef } from 'react'
import { useAdapters } from '../context'
import type { MessageEnvelope } from '@real-life/wot-core'

export function useMessaging() {
  const { messaging, messagingState } = useAdapters()
  const callbacksRef = useRef<Set<(envelope: MessageEnvelope) => void | Promise<void>>>(new Set())

  // Single onMessage subscription that dispatches to all registered callbacks
  useEffect(() => {
    const unsubscribe = messaging.onMessage(async (envelope) => {
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
