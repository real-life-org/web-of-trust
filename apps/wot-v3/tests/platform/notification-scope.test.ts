// Anton 21.10. (#434): 'every namespace' is its own value (ALL_NAMESPACES), not the string 'all',
// which is a possible namespace name. The fake port follows the native one.
import { expect, it } from 'vitest'
import { fakeDevice, fakeEntropy, fakeIdentityPlatform, virtualClock } from '../../src/platform/fake'

it("the fake port treats a namespace named 'all' as one namespace", async () => {
  const d = fakeDevice()
  const p = fakeIdentityPlatform(d, { clock: virtualClock(0, 'UTC'), entropy: fakeEntropy(3) })
  await p.notifications.notify({ ns: 'all', id: 'm1', title: 't', body: '', route: 'c:x' })
  await p.notifications.notify({ ns: 'two', id: 'm1', title: 't', body: '', route: 'c:y' })
  expect((await p.notifications.removeDelivered('all')).ok).toBe(true)
  expect((await p.notifications.list()).map((e) => e.ns)).toEqual(['two'])
  expect(await p.notifications.verifyNone('all')).toBe(true)
  expect(await p.notifications.verifyNone('two')).toBe(false)
})
