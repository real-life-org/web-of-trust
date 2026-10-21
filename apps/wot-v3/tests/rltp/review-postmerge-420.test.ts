// @vitest-environment node
import {expect,it} from 'vitest'
import {pair,isAck,DAY} from './pair'
import type {Transport,TransportHandlers} from '../../src/adapters/rltp/transport'
type Deposit=Parameters<Transport['submit']>[0][number]&{readonly resend?:number;readonly notAfter?:number}
it.each([false,true])('a begun duplicate answer survives the original retry horizon (original retries already ended=%s)',async(ended)=>{
 let reg!:TransportHandlers,saved:Deposit|undefined
 const pending=new Set<Deposit>(),withdrawn:Deposit[]=[]
 const p=await pair(t=>({...t,start(h){reg=h;t.start(h)},submit(out){for(const o of out){if(isAck(o))pending.add(o);else t.submit([o])}},withdraw(out){for(const o of out)if(pending.delete(o))withdrawn.push(o);t.withdraw?.(out)}}),t=>({...t,submit(out){for(const o of out)if(!isAck(o))saved=o;t.submit(out)}}))
 try{
  expect((await p.scanned()).ok).toBe(true);await p.settle();const original=saved!
  p.clock.advance(ended ? 8*DAY : 7*DAY-1000);p.foreground();await p.settle()
  expect(await reg.envelope(original.envelope)).toBe('taken');await p.settle()
  const answer=[...pending].find(o=>o.resend!==undefined)
  expect(answer,'the duplicate started a distinct deposit').toBeDefined()
  if(!ended){p.clock.advance(2000);p.foreground();await p.settle()}
  expect(answer!.notAfter).toBeGreaterThan(p.clock.now())
  const a=Object.values((await p.state()).effects).find(e=>e.ack?.digest===answer!.digest)?.ack
  expect(a?.sentBy).toBe('horizon')
  expect({answerPending:pending.has(answer!),answerWithdrawn:withdrawn.includes(answer!)},'the original retry horizon must not cancel a begun one-shot answer before its own retention deadline').toEqual({answerPending:true,answerWithdrawn:false})
  reg.report({digest:answer!.digest,status:'accepted'},answer!);pending.delete(answer!);await p.settle()
 }finally{await p.close()}
})
