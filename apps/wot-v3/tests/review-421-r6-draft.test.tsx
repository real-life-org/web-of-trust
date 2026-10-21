// Round 6 adversarial probe; assertions describe the required behavior.
// Regressions of Astra's sixth review of #421 (rltp/design/store-launch-v3/app-review-421-6-2026-10-20.md).
/* eslint-disable @typescript-eslint/no-explicit-any -- controlled send outcomes */
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




it('R6: repeated restore keeps the sequence while later sends are still returning',async()=>{
 const {result,send}=setup()
 const failures: ((x:any)=>void)[]=[]
 send.mockImplementation(()=>({actId:'a' as never,done:new Promise(r=>failures.push(r))}))
 for(const text of ['first','second','third']) {
  act(()=>result.current.setText(text));act(()=>result.current.send())
 }
 const fail={ok:false,error:{kind:'infra',code:'storage',retryable:true}}
 await act(async()=>failures[0]!(fail))
 await act(async()=>failures[1]!(fail))
 act(()=>result.current.restoreUnsent())
 expect(result.current.text).toBe('first\nsecond')
 await act(async()=>failures[2]!(fail))
 act(()=>result.current.restoreUnsent())
 expect(result.current.text).toBe('first\nsecond\nthird')
})
