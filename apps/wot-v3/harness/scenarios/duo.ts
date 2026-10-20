// Several phones at IIW for the scenario player (architecture §7.3): Jonas, Priya and Marcus, each
// with an own holder and world, messages between them over the player's shared sim transport.
// Priya's and Marcus' worlds mirror what Jonas' world (iiw.ts) says about them.
import { defineScenario } from '../scenario'
import { iiw } from './iiw'

const T = (local: string) => `${local}-07:00` // PDT

export const iiwPriya = defineScenario({
  id: 'iiw-priya',
  title: 'IIW, day two, on Priya’s phone',
  backend: 'sim',
  clock: iiw.clock,
  world: {
    me: { name: 'Priya Raman', anchorShort: 'z6Mk…9a41' },
    persons: [
      { id: 'jonas', name: 'Jonas Weber' },
      { id: 'lena', name: 'Lena Baumgart' },
    ],
    contacts: [
      { person: 'jonas', verification: 'mutual', trust: { given: true, received: true }, metAt: T('2026-10-14T15:30:00') },
      { person: 'lena', verification: 'mutual', trust: { given: true, received: false }, metAt: T('2026-09-02T12:00:00') },
    ],
    groups: [],
    decisions: [],
    conversations: [
      {
        key: 'c:jonas',
        items: [
          { t: 'sys', system: 'mutual', at: T('2026-10-14T15:30:00') },
          { t: 'msg', from: 'me', text: 'Loved your session on offline verification. Do you have the slides?', at: T('2026-10-14T15:40:00'), status: 'delivered' },
          { t: 'msg', from: 'jonas', text: 'Sure, sending them tonight. Your key recovery demo was great too.', at: T('2026-10-14T15:52:00') },
          { t: 'sys', system: 'trustBoth', at: T('2026-10-14T16:05:00') },
          { t: 'msg', from: 'me', text: 'We are starting a working group on key recovery after IIW. Want in?', at: T('2026-10-15T08:55:00'), status: 'delivered' },
        ],
      },
    ],
  },
})

export const iiwMarcus = defineScenario({
  id: 'iiw-marcus',
  title: 'IIW, day two, on Marcus’ phone',
  backend: 'sim',
  clock: iiw.clock,
  world: {
    me: { name: 'Marcus Chen', anchorShort: 'z6Mk…5d0e' },
    persons: [{ id: 'jonas', name: 'Jonas Weber' }],
    contacts: [{ person: 'jonas', verification: 'outgoing', trust: { given: false, received: false }, metAt: T('2026-10-15T08:10:00') }],
    groups: [],
    decisions: [],
    conversations: [
      {
        key: 'c:jonas',
        items: [
          { t: 'sys', system: 'outgoing', at: T('2026-10-15T08:10:00') },
          { t: 'msg', from: 'me', text: 'Good to meet you at breakfast! I think my phone caught your code, but yours missed mine.', at: T('2026-10-15T08:14:00'), status: 'delivered' },
        ],
      },
    ],
  },
})

export const iiwDuo = defineScenario({
  ...iiw,
  id: 'iiw-duo',
  title: 'IIW, day two, Jonas with Priya and Marcus',
  phones: [
    { label: 'Jonas', scenario: 'iiw', person: 'jonas' },
    { label: 'Priya', scenario: 'iiw-priya', person: 'priya' },
    { label: 'Marcus', scenario: 'iiw-marcus', person: 'marcus' },
  ],
  timeline: [
    { at: '+10s', send: { from: 1, to: 0, text: 'Are you at the Key Recovery session?' } },
    { at: '+1m', send: { from: 0, to: 1, text: 'Yes, second row on the left.' } },
    { at: '+5m', note: 'Transport gone', fault: { transport: 'down' } },
    { at: '+2m', send: { from: 1, to: 0, text: 'Slides are up, check the group.' } },
    { at: '+10m', note: 'Transport back: the queued message arrives', fault: { transport: 'up' } },
    { at: '+1h', send: { from: 2, to: 0, text: 'Can we redo the scan after lunch?' } },
  ],
})
