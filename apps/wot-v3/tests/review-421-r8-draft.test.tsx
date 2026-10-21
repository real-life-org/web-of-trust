// Regressions of Astra's eighth review of #421 (app-review-421-8-2026-10-20.md): R8-5.
import { act, renderHook } from '@testing-library/react'
import { expect, it, vi } from 'vitest'
import { useDraft } from '../src/hooks/messages'
import { AppContextProvider } from '../src/hooks/context'
import { createNavStore } from '../src/app/nav'
import { composeScenario } from '../harness/boot'
import { iiw } from '../harness/scenarios'

it('R8: a rejected first text returns to the field if the second text has already been journaled', async () => {
  const comp = composeScenario(iiw)
  const journals: ((ok: boolean) => void)[] = []
  vi.spyOn(comp.port.trust, 'send').mockImplementation(() => ({
    actId: 'a' as never,
    done: new Promise(() => {}),
    journaled: new Promise<boolean>(r => journals.push(r)),
  }))
  const { result, unmount } = renderHook(() => useDraft('c:marcus'), {
    wrapper: ({ children }) => <AppContextProvider value={{ port: comp.port, platform: comp.platform, nav: createNavStore() }}>{children}</AppContextProvider>,
  })
  try {
    act(() => result.current.setText('first'))
    act(() => result.current.send())
    act(() => result.current.setText('second'))
    act(() => result.current.send())
    await act(async () => journals[1]!(true))
    expect(result.current.text).toBe('')
    await act(async () => journals[0]!(false))
    expect({ text: result.current.text, unsent: result.current.unsent }).toEqual({ text: 'first', unsent: null })
  } finally { unmount() }
})
