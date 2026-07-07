import { useEffect, useState } from 'react'
import { useAdapters } from '../context'
import type { MessagingState } from '@web_of_trust/core/types'

/**
 * Per-broker relay states (primary first) for the status line. Empty array when a
 * single broker is configured — Home then keeps the unchanged aggregate indicator.
 * Reactive via the MultiBrokerMessagingAdapter's onBrokerStatesChange channel,
 * which fires on EVERY child transition (even when the aggregate is unchanged, e.g.
 * the box drops while the public server keeps the connection alive).
 */
export function useBrokerStates(): MessagingState[] {
  const { getBrokerStates, subscribeBrokerStates } = useAdapters()
  const [states, setStates] = useState<MessagingState[]>(() => getBrokerStates())

  useEffect(() => {
    setStates(getBrokerStates())
    return subscribeBrokerStates(setStates)
  }, [getBrokerStates, subscribeBrokerStates])

  return states
}
