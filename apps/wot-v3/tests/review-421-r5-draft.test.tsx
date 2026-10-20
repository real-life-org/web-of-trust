// Round 5 adversarial probe; assertions describe the required behavior.
// Regressions of Astra's fifth review of #421 (rltp/design/store-launch-v3/app-review-421-5-2026-10-20.md).
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




it('R5: returned texts keep gesture order with empty composer',async()=>{
 const {result,send}=setup()
 const failures: ((x:any)=>void)[]=[]
 send.mockImplementation(()=>({actId:'a' as never,done:new Promise(r=>failures.push(r))}))
 act(()=>result.current.setText('first'));act(()=>result.current.send())
 act(()=>result.current.setText('second'));act(()=>result.current.send())
 await act(async()=>failures[0]!({ok:false,error:{kind:'infra',code:'storage',retryable:true}}))
 await act(async()=>failures[1]!({ok:false,error:{kind:'infra',code:'storage',retryable:true}}))
 act(()=>result.current.restoreUnsent())
 expect(result.current.text).toBe('first\nsecond')
})
