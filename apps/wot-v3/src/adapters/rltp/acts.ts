// The human acts the command service runs, by command name, over the holder (architecture §2.7,
// §3.4). One table: the journal names the command, a repeat finds the same function and gives it
// the journaled input and the same actId, so the library's act journal makes it idempotent.

import type { ActResult, Holder, HolderEvent } from '@real-life/trust-protocol'
import { CHALLENGE_MAX_AGE } from '@real-life/trust-protocol'
import { encodeCardLink } from './card-link'
import type { CommandName, ContactId, DecisionId, EncounterOutcome } from '../../port'
import type { IntentPolicy } from './journal'

export interface ActOpts {
  readonly when: number
  readonly actId: string
}

export interface ActSpec {
  readonly policy: IntentPolicy
  run(h: Holder, input: Readonly<Record<string, unknown>>, o: ActOpts): Promise<ActResult>
  /** the port value of a committed act, from its events (and its input) */
  outcome(events: readonly HolderEvent[], input: Readonly<Record<string, unknown>>): unknown
}

const ev = <T extends HolderEvent['type']>(events: readonly HolderEvent[], type: T) =>
  events.filter((e): e is Extract<HolderEvent, { type: T }> => e.type === type)

/** scan → scanned / recognized; capture → captured / already-captured (N9) */
export function encounterOutcome(events: readonly HolderEvent[], role: 'displayed' | 'sent'): EncounterOutcome {
  if (role === 'sent') {
    const rec = ev(events, 'encounter.recorded')[0]
    const prompt = ev(events, 'prompt.opened').find((p) => p.kind === 'encounter-confirm')
    if (rec && prompt) return { kind: 'captured', contactId: rec.contactId as ContactId, decision: prompt.promptId as DecisionId }
    return { kind: 'already-captured', contactId: (rec?.contactId ?? null) as ContactId | null }
  }
  const chained = ev(events, 'contact.chained')[0]
  if (chained) return { kind: 'recognized', contactId: chained.contactId as ContactId }
  const accepted = ev(events, 'encounter.accepted').find((e) => e.mutual)
  if (accepted) return { kind: 'completes', contactId: accepted.contactId as ContactId }
  const scanned = ev(events, 'encounter.scanned')[0] ?? ev(events, 'encounter.recorded')[0]
  return { kind: 'scanned', contactId: (scanned?.contactId ?? '') as ContactId }
}

const str = (input: Readonly<Record<string, unknown>>, k: string): string => {
  const v = input[k]
  if (typeof v !== 'string') throw new Error(`act input ${k} missing`)
  return v
}

export const ACTS: Partial<Record<CommandName, ActSpec>> = {
  showCard: {
    policy: 'discard',
    run: (h, _i, o) => h.show(o),
    outcome: (events) => {
      const shown = ev(events, 'encounter.shown')[0]
      if (!shown) return null
      const issued = (shown.card as { challenge?: { issuedAt?: unknown } }).challenge?.issuedAt
      const issuedAt = typeof issued === 'string' ? Date.parse(issued) : 0
      return { qr: encodeCardLink(shown.card), expiresAt: issuedAt + CHALLENGE_MAX_AGE }
    },
  },
  confirmCard: {
    policy: 'confirm-again',
    run: (h, i, o) => (i.role === 'sent' ? h.captureSentCard(i.card as never, o) : h.scan(i.card as never, o)),
    outcome: (events, i) => encounterOutcome(events, i.role === 'sent' ? 'sent' : 'displayed'),
  },
  counterVerify: {
    policy: 'replay',
    run: (h, i, o) => (typeof i.promptId === 'string' ? h.decide(i.promptId, 'accept', o) : h.counter(str(i, 'contactId'), o)),
    outcome: (_e, i) => (typeof i.promptId === 'string' ? { decided: { prompt: i.promptId, choice: 'accept' } } : null),
  },
  decide: {
    policy: 'replay',
    run: (h, i, o) => h.decide(str(i, 'promptId'), i.choice === 'decline' ? 'decline' : 'accept', o),
    outcome: (_e, i) => ({ decided: { prompt: str(i, 'promptId'), choice: i.choice === 'decline' ? 'decline' : 'accept' } }),
  },
}
