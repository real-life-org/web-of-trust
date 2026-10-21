// @vitest-environment node
// Regressions of Astra's third review of #420 (rltp/design/store-launch-v3/app-review-420-3-2026-10-20.md),
// the reproductions of the review kept as written.
/* eslint-disable @typescript-eslint/no-explicit-any -- the reproductions of the review, kept as written */
import { leaseInUse } from '../../src/adapters/rltp/testing'
import {expect,it,vi} from 'vitest'
import {IDBFactory} from 'fake-indexeddb'
import {rltpHolderHost} from '../../src/adapters/rltp/host'
import {unconfiguredTransport} from '../../src/adapters/rltp/transport'
import {webLockWriter} from '../../src/adapters/rltp/single-writer'
import {virtualClock,fakeEntropy} from '../../src/platform/fake'
import {LOOPBACK_PHRASES,loopbackDevice,memoryCarrier} from '../../harness/loopback'
import {secret} from '../../src/port'
const T0=Date.parse('2026-10-20T10:00:00Z')
const keys=()=>({rootIkm:new Uint8Array(64).fill(1),dek:new Uint8Array(32).fill(2)})
it('parallel opens retain and release their one host lock',async()=>{
 let held=false,released=0,requests=0
 const locks={request:async(_n:any,_o:any,cb:any)=>{requests++;await Promise.resolve();if(held)return cb(null);held=true;try{return await cb({name:'wot-v3-holder'})}finally{held=false;released++}}} as LockManager
 const host=rltpHolderHost({idb:new IDBFactory(),clock:virtualClock(T0,'UTC'),entropy:fakeEntropy(301),transport:unconfiguredTransport(),writer:webLockWriter(locks),publish:()=>{},emit:()=>{},onCurrent:()=>{}})
 const results=await Promise.all([host.open('first',keys()),host.open('second',keys())])
 for(const r of results)if(r.kind==='ok')await host.close(r.holder)
 await new Promise(r=>setTimeout(r,0))
 expect({held,released,requests,results:results.map(r=>r.kind)}).toEqual({held:false,released:1,requests:1,results:['ok','ok']})
})
it('locking a prepared restore never publishes the staged profile',async()=>{
 const carrier=memoryCarrier(),clock=virtualClock(T0,'UTC')
 const A=await loopbackDevice({carrier,clock,id:'A',name:'A',words:LOOPBACK_PHRASES[0],seed:302})
 const r=await A.port.runtime.setup.reserve('restore','passphrase');if(!r.ok)throw Error('reserve')
 expect((await A.port.runtime.setup.writeVault(r.value.ns,{mnemonic:secret(LOOPBACK_PHRASES[1].split(' ')) as any,protection:{mode:'passphrase',passphrase:secret('restored password')},profile:{name:'staged'},termsVersion:A.port.runtime.termsConsent().current})).ok).toBe(true)
 expect((await A.port.runtime.setup.initHolder(r.value.ns)).ok).toBe(true)
 const observed:any[]=[]
 const off=A.port.stores.profile.subscribe(()=>observed.push({profile:A.port.stores.profile.get(),identity:A.port.stores.identity.get()}))
 await A.port.runtime.lock('user');await new Promise(r=>setTimeout(r,0));off()
 expect(observed.filter(x=>x.profile.status==='ready'&&x.profile.value.name==='staged')).toEqual([])
})

it('lock during staged initialization cannot activate that opening',async()=>{
 const carrier=memoryCarrier(),clock=virtualClock(T0,'UTC')
 const A=await loopbackDevice({carrier,clock,id:'A',name:'A',words:LOOPBACK_PHRASES[0],seed:303})
 const r=await A.port.runtime.setup.reserve('restore','passphrase');if(!r.ok)throw Error('reserve')
 await A.port.runtime.setup.writeVault(r.value.ns,{mnemonic:secret(LOOPBACK_PHRASES[1].split(' ')) as any,protection:{mode:'passphrase',passphrase:secret('restored password')},profile:{name:'staged'},termsVersion:A.port.runtime.termsConsent().current})
 let enter!:()=>void,release!:()=>void;const entered=new Promise<void>(r=>enter=r),barrier=new Promise<void>(r=>release=r)
 const original=crypto.subtle.encrypt.bind(crypto.subtle)
 let blocked=false
 const spy=vi.spyOn(crypto.subtle,'encrypt').mockImplementation(async(...args:any[])=>{
  const aad=new TextDecoder().decode(args[0].additionalData), data=new TextDecoder().decode(args[2])
  if(!blocked&&aad===`wot-v3-holder-${r.value.ns}`&&data.includes('staged')){blocked=true;enter();await barrier}
  return original(...args as Parameters<typeof original>)
 })
 let init:Promise<any>|undefined,locking:Promise<any>|undefined
 try{
  init=A.port.runtime.setup.initHolder(r.value.ns);await entered
  locking=A.port.runtime.lock('user')
  await new Promise(r=>setTimeout(r,20))
  const observation={identity:A.port.runtime.state.get().status,ns:A.port.session()?.ns,profile:A.port.stores.profile.get()}
  const late=A.port.trust.showCard();await new Promise(r=>setTimeout(r,20));release()
  const lateResult=await late.done
  expect.soft(lateResult,JSON.stringify(observation)).toMatchObject({ok:false,error:{kind:'locked'}})
  expect(observation).toMatchObject({identity:'locked',ns:undefined,profile:{status:'loading'}})
 }finally{release();await init;await locking;spy.mockRestore()}
})
it('a transport that throws does not fail an act the library committed',async()=>{
 const {openSession}=await import('../../src/adapters/rltp/session')
 const {decodeCardLink}=await import('../../src/adapters/rltp/card-link')
 const clock=virtualClock(T0,'UTC'),carrier=memoryCarrier()
 const B=await loopbackDevice({carrier,clock,id:'B',name:'B',words:LOOPBACK_PHRASES[1],seed:304})
 const card=await B.port.trust.showCard().done;if(!card.ok)throw Error('show')
 const tr=unconfiguredTransport();tr.submit=()=>{throw Error('transport unavailable')}
 const s=await openSession({ns:'sender',generation:1,idb:new IDBFactory(),...keys(),clock,entropy:fakeEntropy(305),transport:leaseInUse(tr, clock),anchorShort:'id',publish:()=>{},emit:()=>{}})
 try{
  const h=s.intent('confirmCard','encounter','capture',{card:decodeCardLink(card.value.qr),role:'displayed'})
  const result=await h.done.then(value=>({value}),error=>({rejected:error.message}))
  await s.idle()
  // the commit is finished durably; the documents go out again with the next resume
  expect({result,intents:s.models()?.intents}).toMatchObject({result:{value:{ok:true,value:{kind:'scanned'}}},intents:[]})
 }finally{await s.quiesce();s.seal();s.close()}
})
