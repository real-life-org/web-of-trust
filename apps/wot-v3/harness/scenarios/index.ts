import type { Scenario } from '../scenario'
import { empty } from './empty'
import { iiw } from './iiw'
import { iiwFuture } from './iiw-future'
import { messageStates } from './message-states'
import { bioInvalidated, freshInstall, gen2Upgrade, locked, recoveryScenario } from './identity'

export const SCENARIOS: Readonly<Record<string, Scenario>> = {
  [iiw.id]: iiw,
  [iiwFuture.id]: iiwFuture,
  [empty.id]: empty,
  [freshInstall.id]: freshInstall,
  [gen2Upgrade.id]: gen2Upgrade,
  [locked.id]: locked,
  [bioInvalidated.id]: bioInvalidated,
  [recoveryScenario.id]: recoveryScenario,
  [messageStates.id]: messageStates,
}

export { iiw, iiwFuture, messageStates, empty, freshInstall, gen2Upgrade, locked, bioInvalidated, recoveryScenario }
