// Two long 1:1 conversations for the scroll position of the thread (e2e/chat-scroll.spec.ts): Noah's
// with 15 unread messages at the end (more than a screen, so the first of them can stand at the top) (the thread opens at the first of them), Lena's fully read (the
// thread opens at the bottom). The harness device lets further messages arrive (__wotDevice.receive).
import { defineScenario } from '../scenario'

const T = (local: string) => `${local}-07:00`
const at = (minute: number) => T(`2026-10-15T${String(10 + Math.floor(minute / 60)).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')}:00`)

/** 49 messages, alternating runs; the last 15 come from `peer` */
function thread(peer: string, label: string) {
  const items = Array.from({ length: 34 }, (_, i) => ({
    t: 'msg' as const,
    from: Math.floor(i / 2) % 2 === 0 ? peer : 'me',
    text: `${label} ${i + 1}: a line of the conversation, long enough to wrap once on a phone.`,
    at: at(i * 2),
    ...(Math.floor(i / 2) % 2 === 0 ? {} : { status: 'delivered' as const }),
  }))
  const unread = Array.from({ length: 15 }, (_, i) => ({ t: 'msg' as const, from: peer, text: `${label} unread ${i + 1}: arrived while the app was closed.`, at: at(80 + i * 3) }))
  return [{ t: 'sys' as const, system: 'mutual' as const, at: T('2026-10-15T09:50:00') }, ...items, ...unread]
}

export const longChat = defineScenario({
  id: 'long-chat',
  title: 'Long conversations',
  backend: 'sim',
  clock: { start: T('2026-10-15T13:30:00'), timeZone: 'America/Los_Angeles' },
  world: {
    me: { name: 'Jonas Weber', anchorShort: 'id…c7f2' },
    persons: [
      { id: 'noah', name: 'Noah Lindqvist' },
      { id: 'lena', name: 'Lena Baumgart' },
    ],
    contacts: [
      { person: 'noah', verification: 'mutual', trust: { given: false, received: false }, metAt: T('2026-10-15T09:50:00') },
      { person: 'lena', verification: 'mutual', trust: { given: false, received: false }, metAt: T('2026-10-15T09:50:00') },
    ],
    groups: [],
    decisions: [],
    conversations: [
      { key: 'c:noah', items: thread('noah', 'Noah') },
      { key: 'c:lena', items: thread('lena', 'Lena') },
    ],
    unread: { 'c:noah': 15 },
  },
})
