// Identity scenarios (architecture §7.5 "first-run", "first-run-legacy-gen2", "locked-*", "restore").
// The harness passphrase and the words are public test values (architecture §5: checkpoints with
// words use only the public test phrase of §5.1).
import { defineScenario } from '../scenario'

const clock = { start: '2026-10-15T09:30:00-07:00', timeZone: 'America/Los_Angeles' }
const world = { me: { name: 'Jonas Weber', anchorShort: '' }, persons: [], contacts: [], groups: [], decisions: [], conversations: [] }

export const freshInstall = defineScenario({
  id: 'fresh-install',
  title: 'First start, no identity',
  backend: 'sim',
  clock,
  world,
  identity: { state: 'none' },
})

export const gen2Upgrade = defineScenario({
  id: 'gen2-upgrade',
  title: 'First v3 start over a Gen-2 install',
  backend: 'sim',
  clock,
  world,
  identity: { state: 'legacy-gen2' },
})

export const locked = defineScenario({
  id: 'locked',
  title: 'Locked, passphrase',
  backend: 'sim',
  clock,
  world,
  identity: { state: 'locked', protection: 'passphrase' },
})

export const bioInvalidated = defineScenario({
  id: 'bio-invalidated',
  title: 'Locked, biometrics changed on the device',
  backend: 'sim',
  clock,
  world,
  identity: { state: 'locked', protection: 'passphrase+biometric', bioInvalidated: true },
})

export const recoveryScenario = defineScenario({
  id: 'recovery',
  title: 'Restore with Magic Words on a fresh device',
  backend: 'sim',
  clock,
  world,
  identity: { state: 'none', startFlow: 'recovery', faults: { biometric: 'unavailable' } },
})
