// The IIW scenario: the design prototype's mock state (RLTP-App-v2), translated literally
// (architecture §7.5). Me: Jonas Weber at IIW, Mountain View, 15 Oct 2026.
//
// Deviations from §7.5, on purpose:
// - Clock 13:30 local instead of 09:30: the prototype has Sofia's message at 12:41 the same day;
//   at 09:30 it would lie in the future.
// - Times of system lines and decision cards are not in the prototype; they sit right before or
//   after the neighbouring message.
// - Daniel (introduced) and Tarek's introduction of Kenji are in iiw-future.ts (introductions: later).
// - The prototype's typing indicator and scripted replies need counterpart scripts (scenario player).

import { defineScenario } from '../scenario'

const T = (local: string) => `${local}-07:00` // PDT

export const iiw = defineScenario({
  id: 'iiw',
  title: 'IIW, day two',
  backend: 'sim',
  clock: { start: T('2026-10-15T13:30:00'), timeZone: 'America/Los_Angeles' },
  world: {
    me: { name: 'Jonas Weber', anchorShort: 'z6Mk…c7f2' },
    persons: [
      { id: 'priya', name: 'Priya Raman' },
      { id: 'marcus', name: 'Marcus Chen' },
      { id: 'sofia', name: 'Sofia Alvarez' },
      { id: 'lena', name: 'Lena Baumgart' },
      { id: 'tarek', name: 'Tarek Aydin' },
      { id: 'noah', name: 'Noah Lindqvist' },
    ],
    contacts: [
      { person: 'priya', verification: 'mutual', trust: { given: true, received: true }, metAt: T('2026-10-14T15:30:00') },
      { person: 'marcus', verification: 'incoming', trust: { given: false, received: false }, metAt: T('2026-10-15T08:10:00') },
      { person: 'sofia', verification: 'outgoing', trust: { given: false, received: false }, metAt: T('2026-10-15T12:35:00') },
      { person: 'lena', verification: 'mutual', trust: { given: true, received: true }, metAt: T('2026-08-12T12:00:00') },
      { person: 'tarek', verification: 'mutual', trust: { given: true, received: false }, metAt: T('2026-08-20T12:00:00') },
    ],
    groups: [
      { id: 'circle', name: 'Offline-First Circle', role: 'member', knownMembers: 14, myHandle: '7C', openAdmissions: 1 },
      { id: 'hof', name: 'Hofgemeinschaft Lindenhof', role: 'member', knownMembers: 9, myHandle: '2A', openAdmissions: 0 },
    ],
    decisions: [
      { id: 'p1', kind: 'encounter-confirm', contact: 'marcus', openedAt: T('2026-10-15T08:15:00') },
      { id: 'p3', kind: 'group-invite', inviter: 'priya', groupName: 'Key Recovery WG', openedAt: T('2026-10-15T08:56:00') },
      {
        id: 'v-circle-marcus',
        kind: 'vouch',
        group: 'circle',
        member: 'member:marcus',
        memberName: 'Marcus Chen',
        have: 1,
        need: 3,
        openedAt: T('2026-10-15T08:50:00'),
      },
    ],
    candidacies: [{ groupName: 'Mesh Night Hackers', inviter: null, have: 2, need: 3 }],
    conversations: [
      {
        key: 'c:priya',
        items: [
          { t: 'sys', system: 'mutual', at: T('2026-10-14T15:30:00') },
          { t: 'msg', from: 'priya', text: 'Loved your session on offline verification. Do you have the slides?', at: T('2026-10-14T15:40:00') },
          { t: 'msg', from: 'me', text: 'Sure, sending them tonight. Your key recovery demo was great too.', at: T('2026-10-14T15:52:00'), status: 'delivered' },
          { t: 'sys', system: 'trustBoth', at: T('2026-10-14T16:05:00') },
          { t: 'msg', from: 'priya', text: 'We are starting a working group on key recovery after IIW. Want in?', at: T('2026-10-15T08:55:00') },
          { t: 'decision', decision: 'p3', at: T('2026-10-15T08:56:00') },
        ],
      },
      {
        key: 'c:tarek',
        items: [{ t: 'msg', from: 'tarek', text: 'Kenji from the DIF call is at IIW too. Introducing you two.', at: T('2026-10-15T07:48:00') }],
      },
      {
        key: 'c:marcus',
        items: [
          { t: 'sys', system: 'incoming', at: T('2026-10-15T08:10:00') },
          { t: 'msg', from: 'marcus', text: 'Good to meet you at breakfast! I think my phone caught your code, but yours missed mine.', at: T('2026-10-15T08:14:00') },
          { t: 'decision', decision: 'p1', at: T('2026-10-15T08:15:00') },
        ],
      },
      {
        key: 'c:sofia',
        items: [
          { t: 'sys', system: 'outgoing', at: T('2026-10-15T12:35:00') },
          { t: 'msg', from: 'me', text: 'Thanks for the lunch chat. Here is the spec I mentioned.', at: T('2026-10-15T12:41:00'), status: 'sent' },
        ],
      },
      {
        key: 'c:lena',
        items: [
          { t: 'msg', from: 'lena', text: 'Wie läuft es in Mountain View? Grüße vom Hof!', at: T('2026-10-14T19:02:00') },
          { t: 'msg', from: 'me', text: 'Gut! Viele gute Gespräche. Ich bringe Kaffee mit.', at: T('2026-10-14T19:30:00'), status: 'delivered' },
        ],
      },
      {
        key: 'g:circle',
        items: [
          { t: 'msg', from: 'member:4F', text: 'Session 12C moved to the main hall.', at: T('2026-10-15T08:30:00') },
          { t: 'msg', from: 'priya', text: 'Thanks! See everyone there.', at: T('2026-10-15T08:34:00') },
          { t: 'decision', decision: 'v-circle-marcus', at: T('2026-10-15T08:50:00') },
          { t: 'msg', from: 'member:9B', text: 'Anyone up for dinner tonight? Thinking Castro Street.', at: T('2026-10-15T09:14:00') },
        ],
      },
      {
        key: 'g:hof',
        items: [
          { t: 'msg', from: 'lena', text: 'Kartoffelernte ist Samstag ab 9 Uhr.', at: T('2026-10-14T12:10:00') },
          { t: 'msg', from: 'member:3D', text: 'Ich bringe Kisten mit.', at: T('2026-10-14T12:25:00') },
        ],
      },
    ],
    unread: { 'g:circle': 2, 'c:tarek': 1, 'c:marcus': 1 },
  },
})
