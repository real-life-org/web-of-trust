import type { Scenario } from '../scenario'
import { empty } from './empty'
import { iiw } from './iiw'
import { iiwFuture } from './iiw-future'

export const SCENARIOS: Readonly<Record<string, Scenario>> = {
  [iiw.id]: iiw,
  [iiwFuture.id]: iiwFuture,
  [empty.id]: empty,
}

export { iiw, iiwFuture, empty }
