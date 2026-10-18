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
  { id: 'system/error', states: [{ state: 'not-ready', scenario: 'none' }] },
]
