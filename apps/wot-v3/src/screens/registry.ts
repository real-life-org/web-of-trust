// Screen catalog (architecture §7.2): every screen with the states it renders. The harness
// catalog and tests/catalog-coverage follow with the scenario player; the scaffold lists the
// screens it has and which scenario shows each state.

export interface ScreenEntry {
  readonly id: string
  readonly states: readonly { readonly state: string; readonly scenario: string; readonly open?: string }[]
}

export const SCREENS: readonly ScreenEntry[] = [
  {
    id: 'contacts/list',
    states: [
      { state: 'ready', scenario: 'iiw' },
      { state: 'empty', scenario: 'empty' },
      { state: 'introduced-contact', scenario: 'iiw-future' },
    ],
  },
  {
    id: 'chat/conversation',
    states: [
      { state: 'ready-mutual-with-decision', scenario: 'iiw', open: 'c:priya' },
      { state: 'ready-incoming-with-decision', scenario: 'iiw', open: 'c:marcus' },
      { state: 'ready-outgoing-note', scenario: 'iiw', open: 'c:sofia' },
    ],
  },
  { id: 'system/placeholder', states: [{ state: 'groups', scenario: 'iiw' }] },
  // Identity screens: every machine state is in harness/catalog.ts (opened with ?catalog=<id>);
  // tests/identity-ui.test.tsx checks that each state of each identity machine has an entry.
  { id: 'identity/onboarding', states: [{ state: 'welcome … done', scenario: 'fresh-install' }] },
  { id: 'identity/recovery', states: [{ state: 'enterWords … done', scenario: 'recovery' }] },
  { id: 'identity/unlock', states: [{ state: 'passphrase', scenario: 'locked' }, { state: 'passphrase{bioUnusable}', scenario: 'bio-invalidated' }] },
  { id: 'identity/legacy-reset', states: [{ state: 'notice', scenario: 'gen2-upgrade' }] },
  { id: 'identity/protection', states: [{ state: 'choose … done', scenario: 'catalog' }] },
  { id: 'identity/delete', states: [{ state: 'explain … done', scenario: 'catalog' }] },
  { id: 'identity/settings', states: [{ state: 'profile tab', scenario: 'iiw' }] },
  { id: 'system/error', states: [{ state: 'error', scenario: 'none' }] },
  { id: 'verify/verify', states: [{ state: 'every state of the verify machine', scenario: 'catalog (harness/catalog-verify.ts)' }, { state: 'two phones, both roles', scenario: 'encounter' }] },
  { id: 'contacts/detail', states: [{ state: 'mutual, incoming', scenario: 'encounter' }] },
]
