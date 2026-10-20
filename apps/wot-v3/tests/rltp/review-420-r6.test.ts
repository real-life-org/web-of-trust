// @vitest-environment node
// Regressions of Astra's sixth review of #420 (rltp/design/store-launch-v3/app-review-420-6-2026-10-20.md).
import { expect, it } from 'vitest'
import { LOOPBACK_PHRASES, loopbackDevice, memoryCarrier } from '../../harness/loopback'
import { fakeEntropy, fakeIdentityPlatform, virtualClock } from '../../src/platform/fake'
import { secret } from '../../src/port'
import { createFlowRunner, identityExecutor } from '../../src/hooks/flow-runner'
import { recovery } from '../../src/flows/setup'

const T0 = Date.parse('2026-10-20T10:00:00Z')
const flush = async () => { for(let i=0;i<15;i++) await new Promise(r=>setTimeout(r,0)) }

it.each([false, true])('R6: offline submission, lock/unlock=%s', async (reopen) => {
  const carrier=memoryCarrier(),clock=virtualClock(T0,'UTC')
  const A=await loopbackDevice({carrier,clock,id:'A',name:'A',words:LOOPBACK_PHRASES[0],seed:611})
  const B=await loopbackDevice({carrier,clock,id:'B',name:'B',words:LOOPBACK_PHRASES[1],seed:612})
  const settle=async()=>{for(let i=0;i<8;i++){await carrier.settled();await A.port.session()?.idle();await B.port.session()?.idle()}await flush()}
  try {
    carrier.setOnline('A',false)
    const card=await B.port.trust.showCard().done;if(!card.ok)throw Error('show')
    expect((await A.port.trust.confirmCard(card.value.qr).done).ok).toBe(true)
    await settle()
    expect(B.port.stores.decisions.get()).toMatchObject({status:'ready',value:[]})
    const ns=A.port.session()!.ns
    if (reopen) {
      await A.port.runtime.lock('user')
      expect((await A.port.runtime.unlock.passphrase(secret('harness passphrase'))).ok).toBe(true)
      expect((await A.port.runtime.unlock.open()).ok).toBe(true)
    }
    expect(A.port.session()!.ns).toBe(ns)
    carrier.setOnline('A',true)
    await settle()
    for(let i=0;i<10;i++){clock.advance(60_000);await settle()}
    expect(B.port.stores.decisions.get()).toMatchObject({status:'ready',value:[{kind:'encounter-confirm'}]})
  } finally {await A.port.runtime.lock('user');await B.port.runtime.lock('user')}
})

it('R6: a failed marker removal in finishRestore leaves the restored identity in use and the marker for the next start', async () => {
  const carrier=memoryCarrier(),clock=virtualClock(T0,'UTC')
  const A=await loopbackDevice({carrier,clock,id:'A',name:'A',words:LOOPBACK_PHRASES[0],seed:621})
  try {
    const r=await A.port.runtime.setup.reserve('restore','passphrase');if(!r.ok)throw Error('reserve')
    await A.port.runtime.setup.writeVault(r.value.ns,{mnemonic:secret(LOOPBACK_PHRASES[2].split(' ')) as never,protection:{mode:'passphrase',passphrase:secret('restored password')},profile:{name:'restored'},termsVersion:A.port.runtime.termsConsent().current})
    expect((await A.port.runtime.setup.initHolder(r.value.ns)).ok).toBe(true)
    expect((await A.port.runtime.setup.switchTo(r.value.ns)).ok).toBe(true)
    expect((await A.port.runtime.setup.wipeOld()).ok).toBe(true)
    expect(A.port.session()).toBeNull()
    let aborted=false
    A.device.vault.beforeCommit=(writes)=>{
      if(writes.some(w=>w.store==='meta' && w.key==='resume' && w.value===undefined)){
        aborted=true
        throw new Error('storage transaction aborted')
      }
    }
    const text={title:'test',subtitle:'test',cancel:'cancel'}
    const runner=createFlowRunner(recovery,{
      state:{name:'verifyingOld',run:1,ns:r.value.ns,survivors:null},
      effects:[{id:'rec.verifyOld',run:1}],row:null,
    },identityExecutor(A.port,A.platform,{unlockPrompt:text,enrollPrompt:text}).setup,A.platform)
    try {
      await runner.idle()
      expect(aborted).toBe(true)
      // the fix publishes (activates) first and removes the marker afterwards: done is true, the
      // identity is usable, the marker stays for the next start
      expect(A.port.runtime.state.get()).toMatchObject({status:'unlocked'})
      expect(A.port.session()?.ns).toBe(r.value.ns)
      expect((await A.port.trust.showCard().done).ok).toBe(true)
      expect(runner.get().name).toBe('done')
      expect(await fakeIdentityPlatform(A.device,{clock,entropy:fakeEntropy(1)}).vault.resume()).toMatchObject({flow:'restore',step:'switched'})
    } finally {runner.dispose()}
  } finally {A.device.vault.beforeCommit=null;await A.port.runtime.lock('user')}
})
