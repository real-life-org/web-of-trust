// The delivery line of an own document (Delivery §6.1 as the port's DeliveryState): under a message,
// and in the interop probe of the developer area.
import type { DeliveryState } from '../../port'
import type { I18n } from '../../i18n'

/** `name`: the contact's first name; a held message waits for that person's device, not for a
 *  connection of this one (RLTP-MSG-5020; Anton 30.10.). Without a name (the interop probe) the generic word. */
export function deliveryWord(d: DeliveryState | null, { t, f }: I18n, name?: string): string | null {
  if (d === null) return null
  switch (d.phase) {
    case 'committing':
    case 'submitted':
      return t.delivery.sending
    case 'held':
      return d.reason === 'not-ready' ? (name ? f(t.delivery.heldNotReadyFor, { name }) : t.delivery.heldNotReady) : d.reason === 'blocked' ? t.delivery.heldBlocked : t.delivery.heldNoChannel
    case 'expired':
      return t.delivery.expired
    case 'queued':
      return t.delivery.waitingForNetwork
    case 'accepted':
      return d.held === true ? t.delivery.held : `${t.delivery.sent} ✓`
    case 'delivered':
      return `${t.delivery.delivered} ✓✓`
    case 'partial':
      return f(t.delivery.partial, { delivered: d.delivered, of: d.of })
    case 'failed':
      return d.reason === 'rejected' && d.code !== undefined ? f(t.delivery.rejected, { code: d.code }) : t.delivery.failed
  }
}
