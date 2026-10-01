import type { WireMessage } from '../../ports/MessagingAdapter'
import { INBOX_MESSAGE_TYPE } from '../../protocol/messaging/inbox-message'
import {
  SPACE_INVITE_MESSAGE_TYPE,
  MEMBER_UPDATE_MESSAGE_TYPE,
  KEY_ROTATION_MESSAGE_TYPE,
} from '../../protocol/sync/membership-messages'
import { ACK_MESSAGE_TYPE } from '../../protocol/sync/ack-message'

/**
 * Dual-broker routing policy (Stage A, Sync 003 §Broker-Zuordnung und Multi-Broker).
 *
 * 'fanout'  — store-and-forward inbox family: idempotent on receive (durable
 *             MessageIdHistory + membership dedup stores), ack is a no-op on a
 *             broker without the message. Safe to send to EVERY reachable broker.
 * 'primary' — EVERYTHING else (default): the log-sync channel (log-entry/1.0,
 *             sync-request/1.0) and anything unknown. Spaces and
 *             personal docs stay SINGLE-HOME in Stage A — no log/control byte may
 *             ever reach a secondary broker (I-PRIMARY-STRICT).
 *
 * Stage B replaces the SOURCE of this policy (space-metadata broker lists)
 * without touching the multiplexer — keep it a pure function.
 */
export type BrokerRoute = 'fanout' | 'primary'

export const FANOUT_TYPES: ReadonlySet<string> = new Set([
  INBOX_MESSAGE_TYPE,
  SPACE_INVITE_MESSAGE_TYPE,
  MEMBER_UPDATE_MESSAGE_TYPE,
  KEY_ROTATION_MESSAGE_TYPE,
  ACK_MESSAGE_TYPE,
])

export function routeForEnvelope(envelope: WireMessage): BrokerRoute {
  const type = (envelope as { type?: unknown }).type
  return typeof type === 'string' && FANOUT_TYPES.has(type) ? 'fanout' : 'primary'
}
