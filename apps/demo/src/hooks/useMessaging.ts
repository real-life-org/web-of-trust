import { useAdapters } from '../context'

/**
 * Relay connection state for the UI. Message handling lives with the
 * InboxReceptionHost and the replication adapter; the Old-World channel this
 * hook used to forward is gone (wot#386).
 */
export function useMessaging() {
  const { messagingState } = useAdapters()
  return {
    state: messagingState,
    isConnected: messagingState === 'connected',
  }
}
