// Encounter commands outside the verify flow (architecture §4.1): the counter-step from a decision
// card or the contact detail, and the interrupted encounters of the intent journal (§3.4, N3).
import { useCallback, useState } from 'react'
import type { ActId, ContactId, IntentView, Result } from '../port'
import { usePlatform, usePort } from './context'
import { useStore } from './useStore'

export function useIntents(): readonly IntentView[] {
  return useStore(usePort().stores.intents)
}

/** Encounter acts journaled before a process loss and waiting for the human (needs-confirmation). */
export function useInterruptedEncounters(): {
  readonly items: readonly IntentView[]
  confirm(actId: ActId): Promise<Result<unknown>>
  discard(actId: ActId): Promise<Result>
} {
  const port = usePort()
  const items = useIntents().filter((i) => i.state === 'needs-confirmation')
  return {
    items,
    confirm: (actId) => port.intents.confirmIntent(actId).done,
    discard: (actId) => port.intents.discardIntent(actId),
  }
}

/** The counter-step toward a contact (accepts its open encounter-confirm, or counters directly). */
export function useCounterVerify(): { readonly busy: boolean; run(contactId: ContactId): Promise<Result> } {
  const port = usePort()
  const [busy, setBusy] = useState(false)
  const run = useCallback(
    async (contactId: ContactId) => {
      setBusy(true)
      try {
        return await port.trust.counterVerify(contactId).done
      } finally {
        setBusy(false)
      }
    },
    [port],
  )
  return { busy, run }
}

/** Copy text (the shown code, for manual entry on the other device). Never throws. */
export function useCopy(): (text: string) => Promise<boolean> {
  const platform = usePlatform()
  return useCallback((text: string) => platform.clipboard.copy(text), [platform])
}
