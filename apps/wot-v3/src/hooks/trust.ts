// Trust toward a contact (Trust 2770, 2840): the one switch of the contact detail. On discloses the
// own anchor (an anchor-mapping goes out; the profile class follows by its default, 2760); off sends
// nothing and discloses nothing new. The hook runs the port's acts and reports whether one is in flight.
import { useCallback, useState } from 'react'
import type { ContactId, Result } from '../port'
import { usePort } from './context'

export function useTrust(contactId: ContactId): { readonly busy: boolean; give(): Promise<Result>; withdraw(): Promise<Result> } {
  const port = usePort()
  const [busy, setBusy] = useState(false)
  const run = useCallback(async (fn: () => Promise<Result>) => {
    setBusy(true)
    try {
      return await fn()
    } finally {
      setBusy(false)
    }
  }, [])
  return {
    busy,
    give: () => run(() => port.trust.giveTrust(contactId).done),
    withdraw: () => run(() => port.trust.withdrawTrust(contactId).done),
  }
}
