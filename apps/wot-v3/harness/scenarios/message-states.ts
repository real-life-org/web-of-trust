// Every look of a message in a 1:1 conversation (simulation): received, sending, sent, delivered,
// waiting for connection (held by the app until the relationship is ready), not delivered with
// "send again as a new message", and an answer with its quote. Screenshots only; the behaviour is
// tested on the real adapter (tests/rltp/messages.loopback.test.ts) and in ?scenario=conversation.
import { defineScenario } from '../scenario'

const T = (local: string) => `${local}-07:00`

export const messageStates = defineScenario({
  id: 'message-states',
  title: 'Message states',
  backend: 'sim',
  clock: { start: T('2026-10-15T13:30:00'), timeZone: 'America/Los_Angeles' },
  world: {
    me: { name: 'Jonas Weber', anchorShort: 'id…c7f2' },
    persons: [{ id: 'noah', name: 'Noah Lindqvist' }],
    contacts: [{ person: 'noah', verification: 'mutual', trust: { given: false, received: false }, metAt: T('2026-10-15T12:50:00') }],
    groups: [],
    decisions: [],
    conversations: [
      {
        key: 'c:noah',
        items: [
          { t: 'sys', system: 'mutual', at: T('2026-10-15T12:50:00') },
          { t: 'msg', from: 'noah', text: 'Great to meet you at the session!', at: T('2026-10-15T12:55:00') },
          { t: 'msg', from: 'me', text: 'Likewise. Here is the spec I mentioned.', at: T('2026-10-15T12:58:00'), status: 'delivered', replyTo: 1 },
          { t: 'msg', from: 'me', text: 'Sent from the hallway.', at: T('2026-10-15T13:05:00'), status: 'sent' },
          { t: 'msg', from: 'me', text: 'This one could not be delivered.', at: T('2026-10-15T13:10:00'), status: 'failed' },
          { t: 'msg', from: 'me', text: 'Waiting until your phone is reachable.', at: T('2026-10-15T13:20:00'), status: 'held' },
          { t: 'msg', from: 'me', text: 'And this one is on its way.', at: T('2026-10-15T13:29:00'), status: 'sending' },
        ],
      },
    ],
  },
})
