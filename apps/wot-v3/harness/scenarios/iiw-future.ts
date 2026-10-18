// IIW plus what the design shows for later (architecture §7.5): Daniel, introduced by Priya.
import { defineScenario } from '../scenario'
import { iiw } from './iiw'

const T = (local: string) => `${local}-07:00`

export const iiwFuture = defineScenario({
  ...iiw,
  id: 'iiw-future',
  title: 'IIW, day two, with introductions',
  world: {
    ...iiw.world,
    persons: [...iiw.world.persons, { id: 'daniel', name: 'Daniel Okafor' }],
    contacts: [
      ...iiw.world.contacts,
      { person: 'daniel', verification: 'introduced', trust: { given: false, received: false }, metAt: null, introducedBy: 'priya' },
    ],
    conversations: [
      ...iiw.world.conversations,
      {
        key: 'c:daniel',
        items: [
          { t: 'sys', system: 'introducedBy', at: T('2026-10-15T09:10:00'), values: { name: 'Priya Raman' } },
          { t: 'msg', from: 'daniel', text: 'Hi! Priya said you work on offline verification. Coffee at the afternoon break?', at: T('2026-10-15T09:20:00') },
        ],
      },
    ],
    unread: { ...iiw.world.unread, 'c:daniel': 1 },
  },
})
