// Regressions of Astra's seventh review of #421 (app-review-421-7-2026-10-20.md): all six result orders, restoring after every result.
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





it.each([[0,1,2],[0,2,1],[1,0,2],[1,2,0],[2,0,1],[2,1,0]])('R7: restoring after each result preserves order %i %i %i', async (...order) => {
 const {result,send,unmount}=setup()
 const failures: ((x:any)=>void)[]=[]
 send.mockImplementation(()=>({actId:'a' as never,done:new Promise(r=>failures.push(r))}))
 const texts=['first','second','third']
 for(const text of texts) {act(()=>result.current.setText(text));act(()=>result.current.send())}
 const fail={ok:false,error:{kind:'infra',code:'storage',retryable:true}}
 const returned:number[]=[]
 for(const index of order) {
  await act(async()=>failures[index]!(fail))
  act(()=>result.current.restoreUnsent())
  returned.push(index)
  expect(result.current.text).toBe([...returned].sort((a,b)=>a-b).map(i=>texts[i]).join('\n'))
 }
 unmount()
})
