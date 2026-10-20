// The composer empties only once the journal holds the text (Anton, 20.10., decision a): a send the
// command service did not take leaves the text in the field; "Not sent: … / Back into the field" only
// when a second text stands in the field by then.
/* eslint-disable @typescript-eslint/no-explicit-any -- controlled send outcomes */
import { act, renderHook } from '@testing-library/react'
import { expect, it, vi } from 'vitest'
import { useDraft } from '../src/hooks/messages'
import { AppContextProvider } from '../src/hooks/context'
import { createNavStore } from '../src/app/nav'
import { composeScenario } from '../harness/boot'
import { iiw } from '../harness/scenarios'

function setup() {
  const comp = composeScenario(iiw)
  const send = vi.spyOn(comp.port.trust, 'send')
  const journals: ((ok: boolean) => void)[] = []
  send.mockImplementation(() => ({ actId: 'a' as never, done: new Promise(() => {}), journaled: new Promise<boolean>((r) => journals.push(r)) }))
  const hook = renderHook(() => useDraft('c:marcus'), {
    wrapper: ({ children }) => <AppContextProvider value={{ port: comp.port, platform: comp.platform, nav: createNavStore() }}>{children}</AppContextProvider>,
  })
  return { ...hook, send, journals }
}

it('the field keeps the text until the journal holds it, then empties', async () => {
  const { result, journals } = setup()
  act(() => result.current.setText('hello'))
  act(() => result.current.send())
  expect(result.current.text).toBe('hello')
  await act(async () => journals[0]!(true))
  expect(result.current.text).toBe('')
  expect(result.current.unsent).toBeNull()
})

it('a second tap while the journal is written is the same gesture', () => {
  const { result, send } = setup()
  act(() => result.current.setText('hello'))
  act(() => result.current.send())
  act(() => result.current.send())
  expect(send).toHaveBeenCalledTimes(1)
})

it('not taken with the field unchanged: the text stays in the field, no "not sent" hint', async () => {
  const { result, journals } = setup()
  act(() => result.current.setText('hello'))
  act(() => result.current.send())
  await act(async () => journals[0]!(false))
  expect(result.current.text).toBe('hello')
  expect(result.current.error).toBe(true)
  expect(result.current.unsent).toBeNull()
})

it('not taken while a second text stands in the field: "not sent" with back into the field; the second text has its own key', async () => {
  const { result, journals, send } = setup()
  act(() => result.current.setText('first'))
  act(() => result.current.send())
  act(() => result.current.setText('second'))
  await act(async () => journals[0]!(false))
  expect(result.current.text).toBe('second')
  expect(result.current.unsent).toBe('first')
  act(() => result.current.send())
  const keys = send.mock.calls.map((c) => c[2])
  expect(keys[1]).not.toBe(keys[0])
  act(() => result.current.restoreUnsent())
  expect(result.current.text).toBe('first')
})

it('taken while a second text stands in the field: the second text stays', async () => {
  const { result, journals } = setup()
  act(() => result.current.setText('first'))
  act(() => result.current.send())
  act(() => result.current.setText('second'))
  await act(async () => journals[0]!(true))
  expect(result.current.text).toBe('second')
  expect(result.current.unsent).toBeNull()
})
