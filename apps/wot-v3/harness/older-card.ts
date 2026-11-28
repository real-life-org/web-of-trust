// The card of encounter-scan as an earlier version of the app showed it, for tests and the harness only.
// The app shows no such card any more (its one ceremony is shared-connect), but it still reads one with
// its camera and keeps the contacts, confirmations and displayed cards an earlier version made. To have
// such a card, or the state an earlier version left behind when it showed one, this runs that version's
// show act: the library's `show` with the carrier offer the session journals for `showCard`, through the
// session's command service, so the stored record, the displayed card's instance and the outcome are the
// ones the current code finishes for an earlier version (acts.ts, session.ts). Never a path of the app.

import { ACTS, type ActSpec } from '../src/adapters/rltp/acts'
import type { Session } from '../src/adapters/rltp/session'
import type { CardRef, Result } from '../src/port'

/** the outcome of an earlier version's show act: the card link, its end and its instance (its N; null
 *  without a carrier offer) */
export interface OlderCard {
  readonly qr: string
  readonly expiresAt: number
  readonly card: CardRef | null
}

/** the input mark of an earlier version's show act; the app's own `showCard` never carries it */
const OLDER = 'olderVersion'
let wrapped: ActSpec | null = null

/** the show act of `ACTS` once wrapped: an input with the mark runs the earlier version's act, any other
 *  input the app's own unchanged */
function wrap(): void {
  const spec = ACTS.showCard
  if (!spec || spec === wrapped) return
  const own = spec.run
  wrapped = {
    ...spec,
    run: async (h, i, o, ctx) => {
      if (i[OLDER] !== true) return own(h, i, o, ctx)
      // the earlier version's act: its carrier offer signs this side's delivery hint for C into the card
      const carrier = await ctx.offer(i.carrier)
      return h.show(carrier ? { ...o, carrier } : o)
    },
  }
  ACTS.showCard = wrapped
}

let n = 0
/** An earlier version of the app shows its card on the device of `session`. */
export function showOlderCard(session: Session): Promise<Result<OlderCard>> {
  wrap()
  return session.intent<OlderCard>('showCard', 'encounter', `showCard|older|${++n}`, { [OLDER]: true }).done
}

/** the same, for a loopback device or a port whose session is open (rejects without one) */
export async function showOlderCardOn(d: { readonly port: { session(): Session | null } }): Promise<Result<OlderCard>> {
  const s = d.port.session()
  if (!s) throw new Error('older card: no session')
  return showOlderCard(s)
}
