// @vitest-environment node
import { expect, it, vi } from 'vitest'
import { IDBFactory } from 'fake-indexeddb'
import { createRltpPort } from '../../src/adapters/rltp'
import { fakeDevice, fakeEntropy, fakeIdentityPlatform, virtualClock } from '../../src/platform/fake'
import { LOOPBACK_PHRASES, loopbackDevice, memoryCarrier } from '../../harness/loopback'
import { secret } from '../../src/port'

const T0 = Date.parse('2026-10-20T10:00:00Z')
const flush = async () => { for (let i=0;i<15;i++) await new Promise(r=>setTimeout(r,0)) }

it('R5 probe: lock revokes a resumed setup while host.init is pending', async () => {
  const clock=virtualClock(T0,'UTC'),device=fakeDevice(),entropy=fakeEntropy(501)
  const identity=fakeIdentityPlatform(device,{clock,entropy}),carrier=memoryCarrier()
  const port=createRltpPort({identity,idb:new IDBFactory(),transport:carrier.endpoint('A'),writer:{acquire:async()=>()=>{}}})
  await port.runtime.boot()
  const r=await port.runtime.setup.reserve('setup','passphrase');if(!r.ok)throw Error('reserve')
  await port.runtime.setup.writeVault(r.value.ns,{mnemonic:secret(LOOPBACK_PHRASES[0].split(' ')) as never,protection:{mode:'passphrase',passphrase:secret('harness passphrase')},profile:{name:'resumed-profile'},termsVersion:port.runtime.termsConsent().current})
  await port.runtime.boot()
  expect(port.runtime.state.get()).toMatchObject({status:'resuming'})
  expect((await port.runtime.unlock.passphrase(secret('harness passphrase'))).ok).toBe(true)
  let enter!:()=>void,release!:()=>void
  const entered=new Promise<void>(r=>enter=r),barrier=new Promise<void>(r=>release=r)
  const original=crypto.subtle.encrypt.bind(crypto.subtle)
  let blocked=false
  const spy=vi.spyOn(crypto.subtle,'encrypt').mockImplementation(async(...args)=>{
    const aad=new TextDecoder().decode((args[0] as AesGcmParams).additionalData)
    const data=new TextDecoder().decode(args[2])
    if(!blocked && aad===`wot-v3-holder-${r.value.ns}` && data.includes('resumed-profile')){
      blocked=true;enter();await barrier
    }
    return original(...args)
  })
  let init:Promise<unknown>|undefined,locking:Promise<unknown>|undefined
  const publishedAfterLock:unknown[]=[]
  const off=port.stores.profile.subscribe(()=>{
    if(locking && port.stores.profile.get().status==='ready') publishedAfterLock.push(port.stores.profile.get())
  })
  try {
    init=port.runtime.setup.initHolder(null)
    await entered
    locking=port.runtime.lock('user')
    await flush()
    // Wait beyond a microtask: quiesce must not wait for a serialized init.
    const current=port.session()
    const command=port.trust.showCard()
    const beforeRelease=await Promise.race([command.done,new Promise(r=>setTimeout(()=>r('pending after 1s'),1000))])
    expect.soft(beforeRelease).toMatchObject({ok:false,error:{kind:'locked'}})
    release()
    const result=await command.done
    await locking
    expect.soft(publishedAfterLock).toEqual([])
    expect.soft(current,'session still accessible after lock').toBeNull()
    expect.soft(result).toMatchObject({ok:false,error:{kind:'locked'}})
  } finally {release();await init;await locking;off();spy.mockRestore();await port.runtime.lock('user')}
})

it('R5 probe: switching identities cannot flush a sealed opening outbox', async () => {
  const carrier=memoryCarrier(),clock=virtualClock(T0,'UTC')
  const A=await loopbackDevice({carrier,clock,id:'A',name:'A',words:LOOPBACK_PHRASES[0],seed:511})
  const B=await loopbackDevice({carrier,clock,id:'B',name:'B',words:LOOPBACK_PHRASES[1],seed:512})
  const settle=async()=>{for(let i=0;i<6;i++){await carrier.settled();await A.port.session()?.idle();await B.port.session()?.idle()}}
  try {
    carrier.setOnline('A',false)
    const card=await B.port.trust.showCard().done;if(!card.ok)throw Error('show')
    await A.port.trust.confirmCard(card.value.qr).done
    await settle()
    expect(B.port.stores.decisions.get()).toMatchObject({status:'ready',value:[]})
    const r=await A.port.runtime.setup.reserve('restore','passphrase');if(!r.ok)throw Error('reserve')
    await A.port.runtime.setup.writeVault(r.value.ns,{mnemonic:secret(LOOPBACK_PHRASES[2].split(' ')) as never,protection:{mode:'passphrase',passphrase:secret('restored password')},profile:{name:'restored'},termsVersion:A.port.runtime.termsConsent().current})
    await A.port.runtime.setup.initHolder(r.value.ns)
    await A.port.runtime.setup.switchTo(r.value.ns)
    await A.port.runtime.setup.wipeOld()
    await A.port.runtime.setup.verifyOld()
    await A.port.runtime.setup.finishRestore()
    carrier.setOnline('A',true)
    await settle()
    expect(B.port.stores.decisions.get()).toMatchObject({status:'ready',value:[]})
  } finally {await A.port.runtime.lock('user');await B.port.runtime.lock('user')}
})

it('R5 probe: unlock for interrupted delete must not activate normal reception',async()=>{
  const carrier=memoryCarrier(),clock=virtualClock(T0,'UTC')
  const A=await loopbackDevice({carrier,clock,id:'A',name:'A',words:LOOPBACK_PHRASES[0],seed:521})
  const B=await loopbackDevice({carrier,clock,id:'B',name:'B',words:LOOPBACK_PHRASES[1],seed:522})
  const settle=async()=>{for(let i=0;i<6;i++){await carrier.settled();await A.port.session()?.idle();await B.port.session()?.idle()}}
  try {
    const card=await B.port.trust.showCard().done;if(!card.ok)throw Error('show')
    await B.port.runtime.delete.quiesce()
    await B.port.runtime.boot()
    expect(B.port.runtime.state.get()).toMatchObject({status:'resuming',step:'wipe'})
    await A.port.trust.confirmCard(card.value.qr).done;await settle()
    expect((await B.port.runtime.unlock.passphrase(secret('harness passphrase'))).ok).toBe(true)
    expect((await B.port.runtime.unlock.open()).ok).toBe(true)
    await settle()
    expect.soft(B.port.stores.decisions.get()).not.toMatchObject({status:'ready',value:[{kind:'encounter-confirm'}]})
    expect.soft(await B.port.trust.showCard().done).toMatchObject({ok:false,error:{kind:'locked'}})
  } finally {await A.port.runtime.lock('user');await B.port.runtime.lock('user')}
})
