// @vitest-environment node
// Regressions of Astra's second review of #420 (rltp/design/store-launch-v3/app-review-420-2-2026-10-20.md):
// the reproductions of the review, with the expectations of the contract.
/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-this-alias -- the reproductions of the review, kept as written */
import {expect,it,vi} from 'vitest'
import {IDBFactory, IDBDatabase} from 'fake-indexeddb'
import {rltpHolderHost} from '../../src/adapters/rltp/host'
import {unconfiguredTransport} from '../../src/adapters/rltp/transport'
import {virtualClock, fakeEntropy} from '../../src/platform/fake'
import {LOOPBACK_PHRASES, loopbackDevice, memoryCarrier} from '../../harness/loopback'
import {secret} from '../../src/port'
const T0=Date.parse('2026-10-20T10:00:00Z')
const keys=()=>({rootIkm:new Uint8Array(64).fill(1),dek:new Uint8Array(32).fill(2)})
const pause=()=>{let resolve!:()=>void;const promise=new Promise<void>(r=>resolve=r);return {resolve,promise}}
const val=(s:any)=>{const x=s.get();if(x.status!=='ready')throw Error(x.status);return x.value}
async function pair(){const carrier=memoryCarrier(),clock=virtualClock(T0,'UTC');const A=await loopbackDevice({carrier,clock,id:'A',name:'A',words:LOOPBACK_PHRASES[0],seed:171});const B=await loopbackDevice({carrier,clock,id:'B',name:'B',words:LOOPBACK_PHRASES[1],seed:172});const settle=async()=>{for(let i=0;i<5;i++){await carrier.settled();await A.port.session()?.idle();await B.port.session()?.idle()}};return {A,B,clock,carrier,settle}}
it('R1-3: a failed createHolder closes its connection before the writer is released',async()=>{
 const idb=new IDBFactory(),release=vi.fn(),close=vi.spyOn(IDBDatabase.prototype,'close');let opened:IDBDatabase|undefined
 const orig=IDBDatabase.prototype.transaction
 const tx=vi.spyOn(IDBDatabase.prototype,'transaction').mockImplementation(function(this:IDBDatabase,...args:any[]){if(this.name==='wot-v3-holder-early'&&args[1]==='readonly'){opened=this;throw Error('read unavailable')}return orig.apply(this,args as any)})
 const host=rltpHolderHost({idb,clock:virtualClock(T0,'UTC'),entropy:fakeEntropy(81),transport:unconfiguredTransport(),writer:{acquire:async()=>release},publish:()=>{},emit:()=>{},onCurrent:()=>{}})
 try{await expect(host.open('early',keys())).rejects.toThrow();expect(opened).toBeDefined();expect(release).toHaveBeenCalledOnce();await new Promise((r)=>setTimeout(r,0))
 const result=await new Promise<string>((r)=>{const q=idb.deleteDatabase('wot-v3-holder-early');q.onblocked=()=>r('blocked');q.onsuccess=()=>r('deleted')});expect(result).toBe('deleted')
 }finally{tx.mockRestore();opened?.close();close.mockRestore()}
})
it('R1-4: an opening still being built keeps the writer when the last registered one closes',async()=>{
 const entered=pause(),barrier=pause();let slow=false,held=false;const release=vi.fn(()=>{held=false})
 const subtle=new Proxy(crypto.subtle,{get(t,k){if(k==='digest')return async(...a:any[])=>{if(slow){entered.resolve();await barrier.promise}return (t.digest as any).apply(t,a)};const v=(t as any)[k];return typeof v==='function'?v.bind(t):v}})
 const host=rltpHolderHost({idb:new IDBFactory(),clock:virtualClock(T0,'UTC'),entropy:fakeEntropy(82),transport:unconfiguredTransport(),writer:{acquire:async()=>{held=true;return release}},subtle,publish:()=>{},emit:()=>{},onCurrent:()=>{}})
 const old=await host.open('old',keys());if(old.kind!=='ok')throw Error('open');slow=true
 const pending=host.open('staged',keys());await entered.promise
 await host.quiesce(old.holder);await host.seal(old.holder);await host.close(old.holder)
 expect(release).not.toHaveBeenCalled();expect(held).toBe(true)
 barrier.resolve();const staged=await pending;expect(staged.kind).toBe('ok');expect(held).toBe(true);expect(host.current()).toBeNull();if(staged.kind==='ok')host.activate?.(staged.holder);expect(host.current()?.ns).toBe('staged')
 if(staged.kind==='ok')await host.close(staged.holder)
 expect(release).toHaveBeenCalledOnce()
})
it('R1-7: network before optics stays honest, the decision is reachable',async()=>{
 const {A,B,settle}=await pair();const shown=await B.port.trust.showCard().done;if(!shown.ok)throw Error('show')
 const scan=await A.port.trust.confirmCard(shown.value.qr).done;if(!scan.ok)throw Error('scan');const sent=await A.port.trust.sentCardFor(scan.value.contactId!);if(!sent.ok)throw Error('sent');await settle()
 const capture=await B.port.trust.confirmCard(sent.value.qr).done
 expect(capture).toMatchObject({ok:true,value:{kind:'already-captured',contactId:null}});expect(val(B.port.stores.decisions)).toHaveLength(1);expect(val(B.port.stores.contacts)[0].verification).toBe('incoming')
})
it('R1-7: an own capture maps back after decline, counter-step and mutual',async()=>{
 const {A,B,carrier,settle}=await pair();carrier.setOnline('A',false)
 const shown=await B.port.trust.showCard().done;if(!shown.ok)throw Error('show');const scan=await A.port.trust.confirmCard(shown.value.qr).done;if(!scan.ok)throw Error('scan');const sent=await A.port.trust.sentCardFor(scan.value.contactId!);if(!sent.ok)throw Error('sent');await B.port.trust.confirmCard(sent.value.qr).done;await settle()
 const d=val(B.port.stores.decisions)[0];await B.port.trust.decide(d.id,'decline').done
 expect(await B.port.trust.confirmCard(sent.value.qr).done).toMatchObject({ok:true,value:{kind:'already-captured',contactId:d.contactId}})
 await B.port.trust.counterVerify(d.contactId).done;expect(val(B.port.stores.contacts)[0].verification).toBe('outgoing')
 expect(await B.port.trust.confirmCard(sent.value.qr).done).toMatchObject({ok:true,value:{kind:'already-captured',contactId:d.contactId}})
 carrier.setOnline('A',true);await settle();expect(val(B.port.stores.contacts)[0].verification).toBe('mutual')
 expect(await B.port.trust.confirmCard(sent.value.qr).done).toMatchObject({ok:true,value:{kind:'already-captured',contactId:d.contactId}})
})
it('R2-1: a finished decision is never published beside views that still show it open; a timer retries',async()=>{
 const {A,B,carrier,clock,settle}=await pair();const shown=await B.port.trust.showCard().done;if(!shown.ok)throw Error('show');await A.port.trust.confirmCard(shown.value.qr).done;await settle();carrier.setOnline('B',false);await settle()
 const d=val(B.port.stores.decisions)[0],orig=IDBDatabase.prototype.transaction
 let fail=true
 const tx=vi.spyOn(IDBDatabase.prototype,'transaction').mockImplementation(function(this:IDBDatabase,...args:any[]){if(fail&&this.name.startsWith('wot-v3-app-')&&args[1]==='readwrite'&&Array.isArray(args[0])&&args[0].includes('kv')&&!args[0].includes('intents'))throw Error('ingestion storage unavailable');return orig.apply(this,args as any)})
 try{
 expect((await B.port.trust.decide(d.id,'decline').done).ok).toBe(true)
 const observed:any[]=[];const off=B.port.stores.decisions.subscribe(()=>observed.push({decisions:val(B.port.stores.decisions),intents:B.port.stores.intents.get()}))
 await B.port.trust.showCard().done;await B.port.session()?.idle();off()
 expect(observed.some(x=>x.decisions.some((d2:any)=>d2.id===d.id&&d2.state==='open')&&!x.intents.some((i:any)=>i.command==='decide'))).toBe(false)
 fail=false
 // the retry timer collects again once the store works
 await settle();await (async()=>{for(let i=0;i<3;i++){await new Promise(r=>setTimeout(r,0))}})()
 clock.advance(1000);await settle();expect(val(B.port.stores.decisions)).toHaveLength(0)
 }finally{tx.mockRestore()}
})
it('R2-2: a staged restore holder does not take over commands or projections before the switch',async()=>{
 const {A}=await pair();const old=A.port.session()!.ns, oldIdentity=A.port.runtime.state.get()
 const r=await A.port.runtime.setup.reserve('restore','passphrase');if(!r.ok)throw Error('reserve')
 expect((await A.port.runtime.setup.writeVault(r.value.ns,{mnemonic:secret(LOOPBACK_PHRASES[1].split(' ')) as any,protection:{mode:'passphrase',passphrase:secret('restored password')},profile:{name:'staged'},termsVersion:A.port.runtime.termsConsent().current})).ok).toBe(true)
 expect((await A.port.runtime.setup.initHolder(r.value.ns)).ok).toBe(true)
 expect(A.port.runtime.state.get()).toEqual(oldIdentity)
 expect(A.port.session()?.ns).toBe(old)
 expect(val(A.port.stores.profile).name).toBe('A')
})
it('R1-9: an unreadable clock high mark aborts the opening; nothing smaller is written',async()=>{
 const {openSession}=await import('../../src/adapters/rltp/session');const {createSealer}=await import('../../src/adapters/rltp/sealed');const {idbAppDb}=await import('../../src/adapters/rltp/app-db');const {decodeCardLink}=await import('../../src/adapters/rltp/card-link')
 const idb=new IDBFactory(),clock=virtualClock(T0,'UTC'),k=keys(),faults={killAt:'after-journal' as 'after-journal'|null}
 const deps={ns:'clock',generation:1,idb,...k,clock,entropy:fakeEntropy(191),transport:unconfiguredTransport(),anchorShort:'id',publish:()=>{},emit:()=>{},faults}
 const {B}=await pair();const shown=await B.port.trust.showCard().done;if(!shown.ok)throw Error('show')
 const s=await openSession(deps);await s.idle();const h=s.intent('confirmCard','encounter','confirm',{card:decodeCardLink(shown.value.qr),role:'displayed'});await h.done;await s.quiesce();s.seal();s.close()
 const db=idbAppDb({idb,name:'wot-v3-app-clock',sealer:await createSealer(k.dek),seal:{sealed:false}})
 await db.write([{store:'kv',key:'clock',value:{high:T0+100*86400000}}]);db.close()
 const orig=IDBDatabase.prototype.transaction;let failed=false
 const tx=vi.spyOn(IDBDatabase.prototype,'transaction').mockImplementation(function(this:IDBDatabase,...args:any[]){if(!failed&&this.name==='wot-v3-app-clock'&&args[0]==='kv'&&args[1]==='readonly'){failed=true;throw Error('transient clock read error')}return orig.apply(this,args as any)})
 let reopened:any
 try{await expect(openSession({...deps,generation:2})).rejects.toThrow();expect(failed).toBe(true)
 reopened=await openSession({...deps,generation:3});await reopened.idle();/* past the manual limit by the high mark: expired, never confirmable */ expect(reopened.models().intents).toEqual([])}finally{tx.mockRestore();if(reopened){await reopened.quiesce();reopened.seal();reopened.close()}}
})
it('R1-10: after the backoff, the network coming back runs the open replay intent again',async()=>{
 const {A,B,clock,carrier,settle}=await pair();const shown=await B.port.trust.showCard().done;if(!shown.ok)throw Error('show');await A.port.trust.confirmCard(shown.value.qr).done;await settle();const d=val(B.port.stores.decisions)[0]
 let fail=true,count=0;const orig=IDBDatabase.prototype.transaction
 const tx=vi.spyOn(IDBDatabase.prototype,'transaction').mockImplementation(function(this:IDBDatabase,...args:any[]){if(fail&&this.name.startsWith('wot-v3-holder-')&&args[1]==='readwrite'){count++;throw Error('holder write unavailable')}return orig.apply(this,args as any)})
 try{expect((await B.port.trust.decide(d.id,'decline').done).ok).toBe(false);await settle();for(const ms of [2000,10000,60000]){clock.advance(ms);await settle()}
 expect(B.port.stores.intents.get()).toMatchObject([{state:'outcome-unknown',retry:{ok:true}}]);const before=count;fail=false
 carrier.setOnline('B',false);await settle();carrier.setOnline('B',true);await settle();clock.advance(10000);await settle()
expect(count).toBe(before);expect(B.port.stores.intents.get()).toEqual([]);expect(val(B.port.stores.decisions).some((x:any)=>x.id===d.id)).toBe(false)
 }finally{tx.mockRestore()}
})
it('R1-2: a sealed and closed app-db cannot recreate a wiped database either',async()=>{
 const {createSealer}=await import('../../src/adapters/rltp/sealed');const {idbAppDb}=await import('../../src/adapters/rltp/app-db');const idb=new IDBFactory(),seal={sealed:false},barrier=pause();let slow=false;const real=await createSealer(keys().dek)
 const app=idbAppDb({idb,name:'wot-v3-app-late',seal,sealer:{open:real.open,seal:async(a,v)=>{if(slow)await barrier.promise;return real.seal(a,v)}}})
 await app.write([{store:'kv',key:'test',value:{x:1}}]);slow=true;const pending=app.write([{store:'kv',key:'test',value:{x:2}}]);seal.sealed=true;app.close()
 await new Promise<void>((r,j)=>{const q=idb.deleteDatabase(app.name);q.onsuccess=()=>r();q.onerror=()=>j(q.error)})
 const rejection=expect(pending).rejects.toThrow('sealed');barrier.resolve();await rejection;expect(await idb.databases()).toEqual([])
})
it('R1-4: a delete keeps the writer through close and forget until the wipe is verified',async()=>{
 const release=vi.fn(),host=rltpHolderHost({idb:new IDBFactory(),clock:virtualClock(T0,'UTC'),entropy:fakeEntropy(183),transport:unconfiguredTransport(),writer:{acquire:async()=>release},publish:()=>{},emit:()=>{},onCurrent:()=>{}})
 const a=await host.open('delete',keys());if(a.kind!=='ok')throw Error('open');await host.quiesce(a.holder);await host.deregister(a.holder,'skip');await host.seal(a.holder);await host.close(a.holder);host.forget('delete');expect(release).not.toHaveBeenCalled();host.wiped?.('delete');expect(release).toHaveBeenCalledOnce()
})
