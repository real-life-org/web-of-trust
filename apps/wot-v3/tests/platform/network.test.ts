// The network port (platform/ports.ts NetworkPort): web follows navigator.onLine and its events; the fake
// is switched by tests and the harness.
import { describe, expect, it } from 'vitest'
import { webNetwork } from '../../src/platform/web'
import { fakeNetwork } from '../../src/platform/fake'

describe('network port', () => {
  it('web: online, offline and unknown from navigator.onLine; online/offline events reach subscribers until they leave', () => {
    const target = new EventTarget()
    const nav: { onLine?: boolean } = { onLine: true }
    const w = Object.assign(target, { navigator: nav })
    const n = webNetwork(w as never)
    expect(n.current()).toBe('online')
    let calls = 0
    const off = n.subscribe(() => calls++)
    nav.onLine = false
    target.dispatchEvent(new Event('offline'))
    expect([n.current(), calls]).toEqual(['offline', 1])
    target.dispatchEvent(new Event('online'))
    off()
    target.dispatchEvent(new Event('online'))
    expect(calls).toBe(2)
    delete nav.onLine
    expect(n.current()).toBe('unknown')
  })
  it('fake: set changes the state and tells subscribers only on a change', () => {
    const n = fakeNetwork()
    let calls = 0
    n.subscribe(() => calls++)
    n.set('online')
    n.set('offline')
    expect([n.current(), calls]).toEqual(['offline', 1])
  })
})
