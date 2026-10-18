// Boot reconciliation (architecture §4.2 boot matrix): from the resume marker, the active pointer
// and what the device holds to the identity state. The runtime has closed session and pending
// before (LIFECYCLE.md "Lock"); this decides and wipes only what the matrix says.

import type { IdentityState, LockInfo } from '../../port'
import type { IdentityPlatform } from '../../platform/ports'
import type { createInventory } from './inventory'

export interface BootContext {
  readonly p: IdentityPlatform
  readonly inv: ReturnType<typeof createInventory>
  /** commits the state (if the boot is still current) and returns the state after it */
  set(next: IdentityState): IdentityState
  /** locked for ns, and ns becomes the target */
  locked(ns: string): Promise<IdentityState>
  lockInfo(ns: string): Promise<LockInfo>
  wipeNamespace(ns: string): Promise<void>
  /** wipes every namespace the vault or the host knows, except keep */
  orphans(keep: readonly string[]): Promise<void>
  /** the namespace being unlocked */
  target(ns: string): void
  /** an interrupted delete of ns continues */
  resumeDelete(ns: string): void
  survivors(out: readonly string[]): void
}

export async function bootMatrix(c: BootContext): Promise<IdentityState> {
  if ((await c.p.storage.probe()) === 'blocked') return c.set({ status: 'storage-blocked' })
  const missing = c.p.storage.cryptoMissing()
  if (missing.length > 0) return c.set({ status: 'crypto-unavailable', missing })

  const m = await c.p.vault.resume()
  if (m?.flow === 'wipe') {
    c.resumeDelete(m.ns)
    const afterSeal = m.step === 'sealed'
    const lock = afterSeal || (await c.p.vault.exists(m.ns)) !== 'v3' ? null : await c.lockInfo(m.ns)
    c.target(m.ns)
    return c.set({ status: 'resuming', step: 'wipe', phase: afterSeal ? 'after-seal' : 'before-seal', lock })
  }
  if (m?.flow === 'legacy-wipe') return c.set({ status: 'legacy-gen2', resume: true })
  if (m?.flow === 'restore' && m.step === 'switched') {
    if ((await c.p.vault.active()) !== m.ns) return c.set({ status: 'storage-blocked' }) // never destroy on suspicion
    c.set({ status: 'resuming', step: 'restore-switch' })
    if (m.nsOld) await c.wipeNamespace(m.nsOld)
    const survivors = m.nsOld ? await c.inv.verifyNamespace(m.nsOld) : []
    c.survivors(survivors)
    if (survivors.length === 0) await c.p.vault.setResume(null) // the marker stays until the old ns is verified gone
    return c.locked(m.ns)
  }
  if (m?.flow === 'restore') {
    // restore/staging: the new namespace goes, the active pointer (old or null) is untouched
    await c.wipeNamespace(m.ns)
    await c.p.vault.setResume(null)
    const active = await c.p.vault.active()
    return active ? c.locked(active) : c.set({ status: 'none', hint: null })
  }
  if (m?.flow === 'setup') {
    if ((await c.p.vault.exists(m.ns)) === 'none') {
      // setup/keystore without vault, or setup/holder whose vault is missing: K, I, H go
      await c.wipeNamespace(m.ns)
      await c.p.vault.setResume(null)
      return c.set({ status: 'none', hint: 'setup-interrupted' })
    }
    // setup/holder (or setup/keystore with a vault, which cannot happen: one transaction)
    c.target(m.ns)
    const info = await c.lockInfo(m.ns)
    if (info.protection === 'passphrase+biometric' && (await c.inv.keystoreHas(m.ns)) === false) {
      await c.p.vault.setBioUnusable(m.ns, true)
      return c.set({ status: 'resuming', step: 'setup', ...info, bioUnusable: true })
    }
    return c.set({ status: 'resuming', step: 'setup', ...info })
  }

  // no marker
  let legacy = await c.p.legacy.detect()
  if (!legacy) {
    try {
      legacy = await c.p.biometric.hasLegacy()
    } catch {
      legacy = false
    }
  }
  if (legacy) return c.set({ status: 'legacy-gen2', resume: false })
  const active = await c.p.vault.active()
  if (!active) {
    await c.orphans([])
    return c.set({ status: 'none', hint: null })
  }
  const v = await c.p.vault.exists(active)
  if (v === 'none') return c.set({ status: 'none', hint: 'access-missing' }) // nothing deleted
  if (v === 'unsupported') {
    c.target(active)
    return c.set({ status: 'locked', ...(await c.lockInfo(active)), unsupported: true })
  }
  await c.orphans([active])
  const head = await c.p.vault.head(active)
  if (head?.protection === 'passphrase' && (await c.inv.keystoreHas(active)) === true) await c.p.biometric.remove(active)
  return c.locked(active)
}
