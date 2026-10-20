import { act, renderHook } from '@testing-library/react'
import { expect, it, vi } from 'vitest'
import { useDraft } from '../src/hooks/messages'
import { AppContextProvider } from '../src/hooks/context'
import { createNavStore } from '../src/app/nav'
import { composeScenario } from '../harness/boot'
import { iiw } from '../harness/scenarios'

it('R10-4: deleting the second text must restore the refused first into the empty field', async () => {
  const comp = composeScenario(iiw)
  let answer!: (ok: boolean) => void
  vi.spyOn(comp.port.trust, 'send').mockImplementation(() => ({
    actId: 'a' as never, done: new Promise(() => {}),
    journaled: new Promise<boolean>(r => { answer = r }),
  }))
  const { result, unmount } = renderHook(() => useDraft('c:marcus'), {
    wrapper: ({ children }) => <AppContextProvider value={{ port: comp.port, platform: comp.platform, nav: createNavStore() }}>{children}</AppContextProvider>,
  })
  try {
    act(() => result.current.setText('first'))
    act(() => result.current.send())
    act(() => result.current.setText('second'))
    await act(async () => answer(false))
    expect(result.current.unsent).toBe('first')
    act(() => result.current.setText(''))
    expect({ text: result.current.text, unsent: result.current.unsent }).toEqual({ text: 'first', unsent: null })
  } finally { unmount() }
})
