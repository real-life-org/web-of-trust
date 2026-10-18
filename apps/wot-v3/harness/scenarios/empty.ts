// First day: an identity, no contacts yet (design: demoEmpty).
import { defineScenario } from '../scenario'

export const empty = defineScenario({
  id: 'empty',
  title: 'First run without contacts',
  backend: 'sim',
  clock: { start: '2026-10-15T13:30:00-07:00', timeZone: 'America/Los_Angeles' },
  world: {
    me: { name: 'Jonas Weber', anchorShort: 'z6Mk…c7f2' },
    persons: [],
    contacts: [],
    groups: [],
    decisions: [],
    conversations: [],
  },
})
