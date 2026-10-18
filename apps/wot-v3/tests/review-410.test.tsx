// Regressions from the review of PR #410 (issues #411, #412, #413), written from the reviewer's probes.
import { act, render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { createSimPort, createSimWorld } from '../src/adapters/sim'
import { createNavStore } from '../src/app/nav'
import { AppContextProvider, useContacts, useConversation } from '../src/hooks'
import { LanguageProvider } from '../src/i18n'
import { fakeEntropy, virtualClock } from '../src/platform/fake'
import type { AppPort, ConversationKey, Loadable } from '../src/port'
import { composeScenario } from '../harness/boot'
import { iiw } from '../harness/scenarios'

const tick = () => new Promise<void>((r) => queueMicrotask(r))

function ready<T>(l: Loadable<T>): T {
  if (l.status !== 'ready') throw new Error(`expected ready, got ${l.status}`)
  return l.value
}

function simWorld(delay = 0) {
  const clock = virtualClock(Date.parse(iiw.clock.start), iiw.clock.timeZone)
  const world = createSimWorld(iiw.world, { clock, entropy: fakeEntropy(), projectionDelayMs: delay })
  return { clock, world, port: createSimPort(world) }
}

function unread(port: AppPort, key: ConversationKey): number {
  return ready(port.stores.contacts.get()).find((c) => c.conversation.key === key)?.conversation.unread ?? -1
}

function lastItemId(port: AppPort, key: ConversationKey): string {
  const items = ready(port.stores.conversation(key).get()).items.filter((i) => i.kind !== 'day')
  return items[items.length - 1]?.id ?? ''
}

describe('#411: every loadable store takes part in the bundle', () => {
  it('a delayed start makes blocked and reports ready together with contacts', async () => {
    const { clock, port } = simWorld(500)
    expect(port.stores.blocked.get().status).toBe('loading')
    clock.advance(500)
    await tick()
    expect(port.stores.contacts.get().status).toBe('ready')
    expect(port.stores.blocked.get().status).toBe('ready')
    expect(port.stores.reports.get().status).toBe('ready')
    const identity = port.stores.identity.get()
    expect(identity.status === 'unlocked' && identity.anchorShort).toBe('z6Mk…c7f2')
  })

  it('after a change all loadable stores carry the same revision', async () => {
    const { world, port } = simWorld()
    world.apply({ type: 'receive', key: 'c:priya', from: 'priya', text: 'one' })
    await tick()
    const s = port.stores
    const revisions = [s.contacts, s.groups, s.decisions, s.candidacies, s.profile, s.standing, s.visibility, s.blocked, s.reports].map(
      (st) => {
        const v = st.get()
        return v.status === 'ready' ? v.asOf : v.status
      },
    )
    expect(new Set(revisions).size).toBe(1)
  })
})

describe('#412: markRead respects the read boundary', () => {
  it('a newer message stays unread when the boundary is older', async () => {
    const { world, port } = simWorld()
    const shown = lastItemId(port, 'c:priya')
    world.apply({ type: 'receive', key: 'c:priya', from: 'priya', text: 'arrived after the render' })
    await tick()
    port.trust.markRead('c:priya', shown)
    await tick()
    expect(unread(port, 'c:priya')).toBe(1)
    port.trust.markRead('c:priya', lastItemId(port, 'c:priya'))
    await tick()
    expect(unread(port, 'c:priya')).toBe(0)
  })

  it('a boundary older than the current read mark does not mark unread again', async () => {
    const { port } = simWorld()
    const first = ready(port.stores.conversation('c:tarek').get()).items.find((i) => i.kind === 'message')!.id
    port.trust.markRead('c:tarek', lastItemId(port, 'c:tarek'))
    await tick()
    port.trust.markRead('c:tarek', first)
    await tick()
    expect(unread(port, 'c:tarek')).toBe(0)
  })
})

describe('#413: the open conversation marks messages with the same timestamp read', () => {
  function Probe() {
    const contacts = useContacts()
    useConversation('c:priya')
    const u = contacts.status === 'ready' ? contacts.value.find((c) => c.id === 'priya')?.conversation.unread : null
    return <span data-testid="unread">{String(u)}</span>
  }

  it('two messages at the same virtual time both end up read', async () => {
    const comp = composeScenario(iiw)
    render(
      <LanguageProvider lang="en">
        <AppContextProvider value={{ port: comp.port, platform: comp.platform, nav: createNavStore() }}>
          <Probe />
        </AppContextProvider>
      </LanguageProvider>,
    )
    await act(async () => {
      comp.world.apply({ type: 'receive', key: 'c:priya', from: 'priya', text: 'one' })
    })
    await act(async () => {})
    await act(async () => {
      comp.world.apply({ type: 'receive', key: 'c:priya', from: 'priya', text: 'two' })
    })
    await act(async () => {})
    expect(screen.getByTestId('unread').textContent).toBe('0')
  })
})
