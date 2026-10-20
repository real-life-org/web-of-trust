// @vitest-environment node
// Regressions of Astra's fourth review of #420 (rltp/design/store-launch-v3/app-review-420-4-2026-10-20.md),
// the probes of the review kept as written.
import { expect, it, vi } from 'vitest'
import { IDBFactory, IDBDatabase } from 'fake-indexeddb'
import { LOOPBACK_PHRASES, loopbackDevice, memoryCarrier } from '../../harness/loopback'
import { virtualClock, fakeEntropy } from '../../src/platform/fake'
import { secret } from '../../src/port'
import { openSession } from '../../src/adapters/rltp/session'
import { unconfiguredTransport } from '../../src/adapters/rltp/transport'
import { decodeCardLink } from '../../src/adapters/rltp/card-link'

const T0 = Date.parse('2026-10-20T10:00:00Z')
const flush = async () => { for(let i=0;i<15;i++) await new Promise(r=>setTimeout(r,0)) }
it('R2-2 counterprobe: a restore opening finishing after lock never publishes', async () => {
  const carrier=memoryCarrier(),clock=virtualClock(T0,'UTC')
  const A=await loopbackDevice({carrier,clock,id:'A',name:'A',words:LOOPBACK_PHRASES[0],seed:401})
  const r=await A.port.runtime.setup.reserve('restore','passphrase'); if(!r.ok)throw Error('reserve')
  await A.port.runtime.setup.writeVault(r.value.ns,{mnemonic:secret(LOOPBACK_PHRASES[1].split(' ')) as never,protection:{mode:'passphrase',passphrase:secret('restored password')},profile:{name:'staged'},termsVersion:A.port.runtime.termsConsent().current})
  let enter!:()=>void,release!:()=>void
  const entered=new Promise<void>(r=>enter=r),barrier=new Promise<void>(r=>release=r)
  const original=crypto.subtle.digest.bind(crypto.subtle)
  let blocked=false
  const spy=vi.spyOn(crypto.subtle,'digest').mockImplementation(async(...args)=>{
    if(!blocked && new TextDecoder().decode(args[1] as ArrayBuffer).startsWith('wot-v3/anchor-short/')){
      blocked=true;enter();await barrier
    }
    return original(...args)
  })
  const observed:unknown[]=[]
  const off=A.port.stores.profile.subscribe(()=>{
    if(A.port.runtime.state.get().status==='locked' && A.port.stores.profile.get().status==='ready')
      observed.push({identity:A.port.runtime.state.get().status,ns:A.port.session()?.ns,profile:A.port.stores.profile.get()})
  })
  let init:Promise<unknown>|undefined
  try {
    init=A.port.runtime.setup.initHolder(r.value.ns)
    await entered
    await A.port.runtime.lock('user')
    expect(A.port.session()).toBeNull()
    release()
    await init
    await flush()
    expect(observed).toEqual([])
  } finally { release();await init;off();spy.mockRestore();await A.port.runtime.lock('user') }
})

it('R3-2 counterprobe: transient submit error retries delivery without reopening', async () => {
  const clock=virtualClock(T0,'UTC'),carrier=memoryCarrier()
  const B=await loopbackDevice({carrier,clock,id:'B',name:'B',words:LOOPBACK_PHRASES[1],seed:402})
  const card=await B.port.trust.showCard().done;if(!card.ok)throw Error('show')
  const tr=unconfiguredTransport()
  let fail=true
  const accepted:unknown[]=[]
  tr.submit=(out)=>{if(fail)throw Error('temporary');accepted.push(...out)}
  const s=await openSession({ns:'sender',generation:1,idb:new IDBFactory(),rootIkm:new Uint8Array(64).fill(1),dek:new Uint8Array(32).fill(2),clock,entropy:fakeEntropy(403),transport:tr,anchorShort:'id',publish:()=>{},emit:()=>{}})
  try {
    await flush();await s.idle()
    const r=await s.intent('confirmCard','encounter','capture',{card:decodeCardLink(card.value.qr),role:'displayed'}).done
    expect(r.ok).toBe(true)
    fail=false
    for(let i=0;i<10;i++){clock.advance(60_000);await flush();await s.idle()}
    expect(accepted.length).toBeGreaterThan(0)
  } finally {await s.quiesce();s.seal();s.close();await B.port.runtime.lock('user')}
})

it('new activation lease keeps mail arriving while the recipient is locked', async () => {
  const clock=virtualClock(T0,'UTC'),carrier=memoryCarrier()
  const A=await loopbackDevice({carrier,clock,id:'A',name:'A',words:LOOPBACK_PHRASES[0],seed:411})
  const B=await loopbackDevice({carrier,clock,id:'B',name:'B',words:LOOPBACK_PHRASES[1],seed:412})
  const settle=async()=>{for(let i=0;i<5;i++){await carrier.settled();await A.port.session()?.idle();await B.port.session()?.idle()}}
  try {
    const card=await B.port.trust.showCard().done;if(!card.ok)throw Error('show')
    await B.port.runtime.lock('user')
    expect((await A.port.trust.confirmCard(card.value.qr).done).ok).toBe(true)
    await settle()
    await B.port.runtime.unlock.passphrase(secret('harness passphrase'))
    expect((await B.port.runtime.unlock.open()).ok).toBe(true)
    await settle()
    clock.advance(60_000);await flush();await settle()
    expect(B.port.stores.decisions.get()).toMatchObject({status:'ready',value:[{kind:'encounter-confirm'}]})
  } finally {await A.port.runtime.lock('user');await B.port.runtime.lock('user')}
})

it('active replays an unknown act after backoff; quiesce removes lifecycle listener', async () => {
  const clock=virtualClock(T0,'UTC'),carrier=memoryCarrier()
  const B=await loopbackDevice({carrier,clock,id:'B',name:'B',words:LOOPBACK_PHRASES[1],seed:422})
  const callbacks=new Set<(st:'active'|'background')=>void>()
  const lifecycle={onState:(cb:(st:'active'|'background')=>void)=>{callbacks.add(cb);return()=>{callbacks.delete(cb)}}}
  const s=await openSession({ns:'active-test',generation:1,idb:new IDBFactory(),rootIkm:new Uint8Array(64).fill(1),dek:new Uint8Array(32).fill(2),clock,entropy:fakeEntropy(423),transport:carrier.endpoint('A'),anchorShort:'id',publish:()=>{},emit:()=>{},lifecycle})
  const settle=async()=>{for(let i=0;i<5;i++){await carrier.settled();await s.idle();await B.port.session()?.idle()}await flush()}
  const orig=IDBDatabase.prototype.transaction
  let failing=false
  const spy=vi.spyOn(IDBDatabase.prototype,'transaction').mockImplementation(function(this: IDBDatabase, ...args:Parameters<IDBDatabase['transaction']>){
    if(failing&&this.name==='wot-v3-holder-active-test'&&args[1]==='readwrite')throw Error('holder temporarily unavailable')
    return orig.apply(this,args)
  })
  try {
    const card=await s.intent<{qr:string}>('showCard','encounter','show',{}).done;if(!card.ok)throw Error('show')
    await B.port.trust.confirmCard(card.value.qr).done;await settle()
    const d=s.models()!.decisions[0]!
    failing=true
    expect((await s.intent('decide',d.id,`decide|${d.id}`,{promptId:d.id,choice:'decline'}).done).ok).toBe(false)
    await settle()
    for(const ms of [2000,10000,60000]){clock.advance(ms);await settle()}
    expect(s.models()?.intents).toMatchObject([{state:'outcome-unknown'}])
    failing=false
    for(const cb of callbacks)cb('active')
    // the replay runs in the background: wait for it, not for a fixed number of turns (flaky under load)
    await vi.waitFor(async()=>{await settle();expect(s.models()?.intents).toEqual([])},{timeout:5000,interval:20})
    expect(s.models()?.decisions).toEqual([])
    await s.quiesce()
    expect(callbacks.size).toBe(0)
  } finally {spy.mockRestore();await s.quiesce();s.seal();s.close();await B.port.runtime.lock('user')}
})

it('a finished restore activates both the new session and its inbound transport', async () => {
  const clock=virtualClock(T0,'UTC'),carrier=memoryCarrier()
  const A=await loopbackDevice({carrier,clock,id:'A',name:'A',words:LOOPBACK_PHRASES[0],seed:431})
  const B=await loopbackDevice({carrier,clock,id:'B',name:'B',words:LOOPBACK_PHRASES[1],seed:432})
  try {
    const old=A.port.session()?.ns
    const r=await A.port.runtime.setup.reserve('restore','passphrase');if(!r.ok)throw Error('reserve')
    await A.port.runtime.setup.writeVault(r.value.ns,{mnemonic:secret(LOOPBACK_PHRASES[2].split(' ')) as never,protection:{mode:'passphrase',passphrase:secret('restored password')},profile:{name:'restored'},termsVersion:A.port.runtime.termsConsent().current})
    expect((await A.port.runtime.setup.initHolder(r.value.ns)).ok).toBe(true)
    expect(A.port.session()?.ns).toBe(old)
    expect((await A.port.runtime.setup.switchTo(r.value.ns)).ok).toBe(true)
    // switched but not yet published unlocked: no opening is in use (review 420 R5-1)
    expect(A.port.session()).toBeNull()
    expect((await A.port.runtime.setup.wipeOld()).ok).toBe(true)
    expect((await A.port.runtime.setup.verifyOld()).ok).toBe(true)
    await A.port.runtime.setup.finishRestore()
    expect(A.port.session()?.ns).toBe(r.value.ns)
    expect(A.port.stores.profile.get()).toMatchObject({status:'ready',value:{name:'restored'}})
    const card=await A.port.trust.showCard().done;if(!card.ok)throw Error('show')
    await B.port.trust.confirmCard(card.value.qr).done
    for(let i=0;i<5;i++){await carrier.settled();await A.port.session()?.idle();await B.port.session()?.idle()}
    expect(A.port.stores.decisions.get()).toMatchObject({status:'ready',value:[{kind:'encounter-confirm'}]})
  } finally {await A.port.runtime.lock('user');await B.port.runtime.lock('user')}
})
