// The human acts the command service runs, by command name, over the holder (architecture §2.7,
// §3.4). One table: the journal names the command, a repeat finds the same function and gives it
// the journaled input and the same actId, so the library's act journal makes it idempotent.

import type { ActResult, CarrierOffer, Holder, HolderEvent } from '@real-life/trust-protocol'
import { CHALLENGE_MAX_AGE } from '@real-life/trust-protocol'
import { encodeCardLink } from './card-link'
import type { CommandName, ContactId, DecisionId, EncounterOutcome, MessageId } from '../../port'
import type { LogLine, MessageLine } from './app-data'
import type { IntentPolicy } from './journal'

export interface ActOpts {
  readonly when: number
  readonly actId: string
}

/** what an act needs of its opening beside the holder */
export interface ActContext {
  /** the library's carrier offer from the journaled one in the act input (carrier-offer.ts) */
  offer(raw: unknown): Promise<CarrierOffer | undefined>
}

export interface ActSpec {
  readonly policy: IntentPolicy
  run(h: Holder, input: Readonly<Record<string, unknown>>, o: ActOpts, ctx: ActContext): Promise<ActResult>
  /** the port value of a committed act, from its events (and its input) */
  outcome(events: readonly HolderEvent[], input: Readonly<Record<string, unknown>>): unknown
  /** lines the act leaves in the app's history, written in the transaction that finishes the intent
   *  (§3.4 step 4, N4): on success from the events, on a refusal from the code */
  lines?(r: { ok: true; events: readonly HolderEvent[] } | { ok: false; code: string }, input: Readonly<Record<string, unknown>>, when: number): readonly LogLine[]
  /** an act of the contact order (CONTACT-ORDER.md): every gesture of these commands and every
   *  recovery of their records runs in the contact's serial section; a newer gesture supersedes the
   *  open record of an older one of the same lane */
  readonly ordered?: true
  /** the lane of an ordered act: the part of the contact's state it sets. Only a gesture of the same
   *  lane covers an older one's target state and supersedes its open record; another lane's open
   *  record stays and is completed first (review 483 B1). Default: the command's name. */
  lane?(input: Readonly<Record<string, unknown>>): string
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
function merge(a: ActResult, b: ActResult): ActResult {
  if (!a.ok) return a
  if (!b.ok) return b
  const due = [a.nextDueAt, b.nextDueAt].filter((x): x is number => x !== undefined)
  return { ok: true, outbound: [...a.outbound, ...b.outbound], events: [...a.events, ...b.events], ...(due.length ? { nextDueAt: Math.min(...due) } : {}) }
}

/** A state act of two library acts under part ids of the one intent (§2.7 rule 2): each part answers
 *  from the library's act journal when it committed, else it runs (CONTACT-ORDER.md "parts"). A first
 *  run and every recovery are the same call: a part never runs twice under its actId, a missing part
 *  is completed, also at and after the deadline. These acts set a state on this device and send
 *  nothing the other side sees; past the library's retention a part runs again and sets the same
 *  state. */
async function parts(h: Holder, when: number, list: readonly (readonly [string, () => Promise<ActResult>])[]): Promise<ActResult> {
  let out: ActResult | null = null
  for (const [actId, run] of list) {
    const rp = await h.replay(actId, when)
    const r: ActResult = rp.ok ? { ok: true, outbound: [], events: [...rp.result.events] } : await run()
    if (!r.ok) return r
    out = out ? merge(out, r) : r
  }
  return out ?? { ok: true, outbound: [], events: [] }
}

const str = (input: Readonly<Record<string, unknown>>, k: string): string => {
  const v = input[k]
  if (typeof v !== 'string') throw new Error(`act input ${k} missing`)
  return v
}

export const ACTS: Partial<Record<CommandName, ActSpec>> = {
  showCard: {
    policy: 'discard',
    // the displayed card carries this side's delivery hint for C under its proof (lib 0.8.0)
    run: async (h, i, o, ctx) => {
      const carrier = await ctx.offer(i.carrier)
      return h.show(carrier ? { ...o, carrier } : o)
    },
    outcome: (events, i) => {
      const shown = ev(events, 'encounter.shown')[0]
      if (!shown) return null
      const issued = (shown.card as { challenge?: { issuedAt?: unknown } }).challenge?.issuedAt
      const issuedAt = typeof issued === 'string' ? Date.parse(issued) : 0
      // the card's instance is its N, journaled with the act's carrier offer (TRANSPORT.md "The
      // displayed card's instance"); a card shown without an offer has none
      const offer = i.carrier as { nonce?: unknown } | undefined
      const card = typeof offer?.nonce === 'string' ? offer.nonce : null
      return { qr: encodeCardLink(shown.card), expiresAt: issuedAt + CHALLENGE_MAX_AGE, card }
    },
  },
  confirmCard: {
    policy: 'confirm-again',
    // the scanner's sent card carries its delivery hint for C (lib 0.8.0); a capture offers none
    run: async (h, i, o, ctx) => {
      if (i.role === 'sent') return h.captureSentCard(i.card as never, o)
      const carrier = await ctx.offer(i.carrier)
      return h.scan(i.card as never, carrier ? { ...o, carrier } : o)
    },
    outcome: (events, i) => encounterOutcome(events, i.role === 'sent' ? 'sent' : 'displayed'),
  },
  counterVerify: {
    policy: 'replay',
    run: (h, i, o) => (typeof i.promptId === 'string' ? h.decide(i.promptId, 'accept', o) : h.counter(str(i, 'contactId'), o)),
    outcome: (_e, i) => (typeof i.promptId === 'string' ? { decided: { prompt: i.promptId, choice: 'accept' } } : null),
  },
  // Trust is a setting on this device (Trust 2770, 2840): on sends the own anchor (an anchor-mapping),
  // nothing on the wire says "trust"; the other side derives "trusts you" from the verified anchor it
  // holds. Off sends nothing; what was disclosed stays disclosed. The pause is the star and the
  // blinded group star off (2780). The acts run in the contact order like block and unblock.
  giveTrust: {
    policy: 'replay',
    ordered: true,
    lane: () => 'trust',
    run: (h, i, o) => h.trust(str(i, 'contactId'), o),
    outcome: () => undefined,
  },
  withdrawTrust: {
    policy: 'replay',
    ordered: true,
    lane: () => 'trust',
    run: (h, i, o) => h.untrust(str(i, 'contactId'), o),
    outcome: () => undefined,
  },
  setPaused: {
    policy: 'replay',
    ordered: true,
    lane: () => 'pause',
    run: (h, i, o) => h.pauseTrust(str(i, 'contactId'), i.paused === true, o),
    outcome: () => undefined,
  },
  setClass: {
    policy: 'replay',
    ordered: true,
    lane: (i) => `class:${str(i, 'cls')}`,
    run: (h, i, o) => h.setClass(str(i, 'contactId'), str(i, 'cls') as never, str(i, 'setting') as never, o),
    outcome: () => undefined,
  },
  // The own profile (Trust 6b): one revision for every contact the profile class is on for, by
  // default the trusted ones (2760, 6455); the library delivers it and re-sends the current one when
  // the class turns on toward a contact (2850).
  setProfile: {
    policy: 'replay',
    run: (h, i, o) => h.setProfile(typeof i.image === 'string' ? { name: str(i, 'name'), image: i.image } : { name: str(i, 'name') }, o),
    outcome: () => undefined,
  },
  // Blocking is silent: the block plus the pause (paper §7.1); unblocking clears both (§7.6). Two
  // library acts under part ids of the one intent (§2.7 rule 2), in the contact order.
  block: {
    policy: 'replay',
    ordered: true,
    lane: () => 'block',
    run: (h, i, o) =>
      parts(h, o.when, [
        [`${o.actId}:block`, () => h.block(str(i, 'contactId'), { ...o, actId: `${o.actId}:block` })],
        [`${o.actId}:pause`, () => h.pauseTrust(str(i, 'contactId'), true, { ...o, actId: `${o.actId}:pause` })],
      ]),
    outcome: () => undefined,
  },
  unblock: {
    policy: 'replay',
    ordered: true,
    lane: () => 'block',
    run: (h, i, o) =>
      parts(h, o.when, [
        [`${o.actId}:unblock`, () => h.unblock(str(i, 'contactId'), { ...o, actId: `${o.actId}:unblock` })],
        [`${o.actId}:resume`, () => h.pauseTrust(str(i, 'contactId'), false, { ...o, actId: `${o.actId}:resume` })],
      ]),
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
