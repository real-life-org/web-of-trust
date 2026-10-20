// Scenarios the player offers: every harness scenario plus the multi-phone ones.
import type { Scenario } from '../scenario'
import { SCENARIOS } from '../scenarios'
import { iiwDuo, iiwMarcus, iiwPriya } from '../scenarios/duo'

export const PLAYER_SCENARIOS: Readonly<Record<string, Scenario>> = {
  ...SCENARIOS,
  [iiwDuo.id]: iiwDuo,
  [iiwPriya.id]: iiwPriya,
  [iiwMarcus.id]: iiwMarcus,
}
