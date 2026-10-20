/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unused-vars, @typescript-eslint/consistent-type-imports -- the probes of the review, kept as written */
// Regressions of Astra's second review of #421 (rltp/design/store-launch-v3/app-review-421-2-2026-10-20.md),
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

it('R2 probe: storage failure cannot lose the previous text while a new draft is being typed',async()=>{
 const {result,send}=setup()
 let fail!:(x:any)=>void
 send.mockReturnValue({actId:'a' as never,done:new Promise(r=>fail=r)})
 act(()=>result.current.setText('first unsaved text'))
 act(()=>result.current.send())
 act(()=>result.current.setText('second draft'))
 await act(async()=>fail({ok:false,error:{kind:'infra',code:'storage',retryable:true}}))
 // kept beside the new draft, then back into the field before it
 expect(result.current.unsent).toBe('first unsaved text')
 expect(result.current.text).toBe('second draft')
 act(()=>result.current.restoreUnsent())
 expect(result.current.text).toBe('first unsaved text\nsecond draft')
 expect(result.current.unsent).toBeNull()
})
