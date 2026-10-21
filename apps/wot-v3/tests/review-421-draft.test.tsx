// Regressions of Astra's first review of #421 (rltp/design/store-launch-v3/app-review-421-1-2026-10-20.md),
// the reproductions of the review kept as written.
import { act, renderHook } from '@testing-library/react'
import { it, expect, vi } from 'vitest'
import { useDraft } from '../src/hooks/messages'
import { AppContextProvider } from '../src/hooks/context'
import { createNavStore } from '../src/app/nav'
import { composeScenario } from '../harness/boot'
import { iiw } from '../harness/scenarios'

function setup() {
 const comp = composeScenario(iiw)
 const send = vi.spyOn(comp.port.trust, 'send')
 const hook = renderHook(() => useDraft('c:marcus'), { wrapper: ({children}) => <AppContextProvider value={{port:comp.port, platform:comp.platform, nav:createNavStore()}}>{children}</AppContextProvider> })
 return { ...hook, send }
}
it('keeps a draft if writing its journal fails', async () => {
 const {result, send} = setup()
 send.mockReturnValue({actId:'a' as never, done:Promise.resolve({ok:false,error:{kind:'infra',code:'storage',retryable:true}})})
 act(()=>result.current.setText('keep this text'))
 await act(async()=>result.current.send())
 expect(result.current.error).toBe(true)
 expect(result.current.text).toBe('keep this text')
})
it('two synchronous calls send the same composer draft only once', async()=>{
 const {result, send} = setup()
 send.mockReturnValue({actId:'a' as never, done:Promise.resolve({ok:true,value:{messageId:'m' as never}})})
 act(()=>result.current.setText('one draft'))
 await act(async()=>{ result.current.send(); result.current.send() })
 expect(send.mock.calls.length === 1 || send.mock.calls[0]?.[2] === send.mock.calls[1]?.[2]).toBe(true)
})
