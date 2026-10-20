// The human acts the command service runs, by command name, over the holder (architecture §2.7,
// §3.4). One table: the journal names the command, a repeat finds the same function and gives it
// the journaled input and the same actId, so the library's act journal makes it idempotent.

import type { ActResult, Holder, HolderEvent } from '@real-life/trust-protocol'
import { CHALLENGE_MAX_AGE } from '@real-life/trust-protocol'
import { encodeCardLink } from './card-link'
import type { CommandName, ContactId, DecisionId, EncounterOutcome, MessageId } from '../../port'
import type { LogLine, MessageLine } from './app-data'
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
  /** lines the act leaves in the app's history, written in the transaction that finishes the intent
   *  (§3.4 step 4, N4): on success from the events, on a refusal from the code */
  lines?(r: { ok: true; events: readonly HolderEvent[] } | { ok: false; code: string }, input: Readonly<Record<string, unknown>>, when: number): readonly LogLine[]
}

/** the refusals on which the app keeps a message unsent (Message Tasks 5.1) */
export const HELD = ['not-ready', 'blocked', 'no-own-channel'] as const

export function ownMessageLine(input: Readonly<Record<string, unknown>>, when: number, patch: Partial<MessageLine>): MessageLine {
  const contactId = String(input.contactId)
  const draftKey = String(input.draftKey)
  return {
    kind: 'message',
    id: `msg:out:${draftKey}`,
    key: `c:${contactId}`,
    at: when,
    dir: 'out',
    contactId,
    text: String(input.text),
    mid: null,
    replyTo: typeof input.replyTo === 'string' ? input.replyTo : null,
    sentAt: when,
    receivedAt: null,
    digest: null,
    draftKey,
    held: null,
    status: null,
    ...patch,
  }
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

/** Two acts as one result: the second only after the first committed; outbound, events and due
 *  times of both. A refusal of the first is the answer; the second's refusal too. */
async function both(first: Promise<ActResult>, second: () => Promise<ActResult>): Promise<ActResult> {
  const a = await first
  if (!a.ok) return a
  const b = await second()
  if (!b.ok) return b
  const due = [a.nextDueAt, b.nextDueAt].filter((x): x is number => x !== undefined)
  return { ok: true, outbound: [...a.outbound, ...b.outbound], events: [...a.events, ...b.events], ...(due.length ? { nextDueAt: Math.min(...due) } : {}) }
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
  // Blocking is silent: the block plus the pause (paper §7.1); unblocking clears both (§7.6). Two
  // library acts under part ids of the one intent (§2.7 rule 2): a repeat finds both journaled.
  block: {
    policy: 'replay',
    run: (h, i, o) => both(h.block(str(i, 'contactId'), { ...o, actId: `${o.actId}:block` }), () => h.pauseTrust(str(i, 'contactId'), true, { ...o, actId: `${o.actId}:pause` })),
    outcome: () => undefined,
  },
  unblock: {
    policy: 'replay',
    run: (h, i, o) => both(h.unblock(str(i, 'contactId'), { ...o, actId: `${o.actId}:unblock` }), () => h.pauseTrust(str(i, 'contactId'), false, { ...o, actId: `${o.actId}:resume` })),
    outcome: () => undefined,
  },
  send: {
    policy: 'replay',
    run: (h, i, o) => h.sendMessage(str(i, 'contactId'), str(i, 'text'), typeof i.replyTo === 'string' ? { ...o, replyTo: i.replyTo } : o),
    outcome: (_e, i) => ({ messageId: `msg:out:${str(i, 'draftKey')}` as MessageId }),
    lines(r, input, when) {
      if (r.ok) {
        const sent = ev(r.events, 'message.sent')[0]
        if (!sent) return []
        // whole seconds like the document's sentAt (3030); the fence refines it from the submission
        const at = Math.floor(when / 1000) * 1000
        return [ownMessageLine(input, at, { mid: sent.mid, digest: sent.digest, status: { phase: 'submitted' } })]
      }
      const held = (HELD as readonly string[]).includes(r.code) ? (r.code as (typeof HELD)[number]) : null
      if (held) return [ownMessageLine(input, when, { held, status: { phase: 'held', reason: held } })]
      // any other refusal after the journal took the text: the text stays, not delivered, with "send
      // again as a new message" (review 421 R8-2)
      return [ownMessageLine(input, when, { status: { phase: 'failed', reason: 'rejected', retry: { ok: false, reason: 'not-supported' } } })]
    },
  },
  decide: {
    policy: 'replay',
    run: (h, i, o) => h.decide(str(i, 'promptId'), i.choice === 'decline' ? 'decline' : 'accept', o),
    outcome: (_e, i) => ({ decided: { prompt: str(i, 'promptId'), choice: i.choice === 'decline' ? 'decline' : 'accept' } }),
  },
}
