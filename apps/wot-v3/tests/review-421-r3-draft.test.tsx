/* eslint-disable @typescript-eslint/no-explicit-any -- the probes of the review, kept as written */
// Regressions of Astra's third review of #421 (rltp/design/store-launch-v3/app-review-421-3-2026-10-20.md),
// the probes of the review; where the fix chose the reviewer's alternative, the expectation says so.
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


it('R3: two rejected sends preserve both texts beside the next draft',async()=>{
 const {result,send}=setup()
 const failures: ((x:any)=>void)[]=[]
 send.mockImplementation(()=>({actId:'a' as never,done:new Promise(r=>failures.push(r))}))
 act(()=>result.current.setText('first'))
 act(()=>result.current.send())
 act(()=>result.current.setText('second'))
 act(()=>result.current.send())
 act(()=>result.current.setText('third'))
 await act(async()=>failures[0]!({ok:false,error:{kind:'infra',code:'storage',retryable:true}}))
 await act(async()=>failures[1]!({ok:false,error:{kind:'infra',code:'storage',retryable:true}}))
 act(()=>result.current.restoreUnsent())
 expect(result.current.text).toContain('first')
 expect(result.current.text).toContain('second')
 expect(result.current.text).toContain('third')
})
