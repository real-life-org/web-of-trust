import { createSimPort, createSimWorld } from '../src/adapters/sim'
import { fakeEntropy, virtualClock } from '../src/platform/fake'
import { iiw } from '../harness/scenarios'
import { portContract } from './port-contract'

function world(delay = 0) {
  const clock = virtualClock(Date.parse(iiw.clock.start), iiw.clock.timeZone)
  const w = createSimWorld(iiw.world, { clock, entropy: fakeEntropy(), projectionDelayMs: delay })
  return { clock, world: w, port: createSimPort(w) }
}

portContract(
  'simulation',
  () => {
    const { world: w, port } = world()
    return {
      port,
      key: 'c:priya',
      otherKey: 'c:lena',
      change: () => w.apply({ type: 'receive', key: 'c:priya', from: 'priya', text: 'Perfect, thanks!' }),
    }
  },
  {
    pending: () => {
      const { clock, port } = world(500)
      return { port, release: () => clock.advance(500) }
    },
  },
)
