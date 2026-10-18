// Events are only for the ephemeral: toast, confetti, local notification, focus change
// (architecture §2.5). They are never the only source of a state; what stays is in a read model.
// Delivered at most once per process, with eventId for deduplication, no replay after restart.

import type { AppError } from './errors'
import type { ActId, ContactId, ConversationKey, DecisionId, GroupId, MemberRef, MessageId } from './ids'
import type { Decision, DecisionResolution } from './models'

export type AppEvent = { readonly eventId: string; readonly actId?: ActId } & (
  | { readonly type: 'encounter.mutual'; readonly contactId: ContactId; readonly isNew: boolean }
  | { readonly type: 'encounter.recognized'; readonly contactId: ContactId }
  | { readonly type: 'decision.opened'; readonly decision: DecisionId; readonly kind: Decision['kind'] }
  | { readonly type: 'decision.closed'; readonly decision: DecisionId; readonly resolution: DecisionResolution }
  | { readonly type: 'message.received'; readonly key: ConversationKey; readonly messageId: MessageId }
  | { readonly type: 'message.failed'; readonly key: ConversationKey; readonly messageId: MessageId }
  | { readonly type: 'trust.received'; readonly contactId: ContactId }
  | { readonly type: 'group.joined'; readonly groupId: GroupId }
  | { readonly type: 'group.admitted'; readonly groupId: GroupId; readonly member: MemberRef }
  | { readonly type: 'identity.locked'; readonly reason: 'user' | 'background-timeout' }
  | { readonly type: 'infra.degraded'; readonly error: AppError }
)

export interface AppEvents {
  subscribe(listener: (e: AppEvent) => void): () => void
}
