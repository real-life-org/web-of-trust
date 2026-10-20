// Regressions of Astra's ninth review of #421 (app-review-421-9-2026-10-20.md): R9-5.
import { act, renderHook } from '@testing-library/react'
import { expect, it, vi } from 'vitest'
import { useDraft } from '../src/hooks/messages'
import { AppContextProvider } from '../src/hooks/context'
import { createNavStore } from '../src/app/nav'
import { composeScenario } from '../harness/boot'
import { iiw } from '../harness/scenarios'

it('R9: first rejected, then second journaled must restore first into the now empty field', async () => {
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
    await act(async () => journals[0]!(false))
    expect(result.current.unsent).toBe('first')
    await act(async () => journals[1]!(true))
    expect({ text: result.current.text, unsent: result.current.unsent }).toEqual({ text: 'first', unsent: null })
  } finally { unmount() }
})
