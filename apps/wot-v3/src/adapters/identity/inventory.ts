// What the identity runtime reads and removes (architecture §4.2 "Löschinventar", Gen-2 reset, §2.3
// LockInfo): the lock info of a namespace, wipeNamespace (layers 1 to 7, nothing outside ns, N6),
// verifyNamespaceWiped (layer 8), the global layers of a full delete and the Gen-2 survivors. The
// holder openings of ns are the register's (resources.ts); the runtime releases them before it
// calls wipeNamespace here.

import type { LockInfo, ProtectionMode } from '../../port'
import { ALL_NAMESPACES, type IdentityPlatform } from '../../platform/ports'
import type { HolderHost } from './host'

export const nsPrefs = (ns: string) => `${ns}:`
/** the native notification port's ID table of a namespace (`<ns>:notify.ids`) */
const NOTIFY_IDS = ':notify.ids'

export function createInventory(p: IdentityPlatform, host: HolderHost) {
  const keystoreHas = async (ns: string): Promise<boolean | null> => {
    try {
      return await p.biometric.hasEntry(ns)
    } catch {
      return null // strict check failed: unknown, never assumed absent
    }
  }

  /** offerBiometric is derived from the protection, the biometrics and the dismissal (sync) */
  const offer = (ns: string, protection: ProtectionMode, biometric: unknown) =>
    protection === 'passphrase' && biometric !== null && p.prefs.get(`${nsPrefs(ns)}bio-offer-dismissed`) !== '1'

  const lockInfo = async (ns: string): Promise<LockInfo> => {
    const exists = await p.vault.exists(ns)
    const head = exists === 'v3' ? await p.vault.head(ns) : null
    const avail = await p.biometric.availability()
    const biometric = avail.kind === 'available' ? avail.type : null
    const protection: ProtectionMode = head?.protection ?? 'passphrase'
    const k = head && protection !== 'passphrase' ? await keystoreHas(ns) : null
    return {
      protection,
      biometric,
      biometricLost: protection === 'biometric-only' && k === false,
      bioUnusable: head ? await p.vault.bioUnusable(ns) : false,
      unsupported: exists === 'unsupported',
      offerBiometric: offer(ns, protection, biometric),
    }
  }

  const hostNamespaces = async (): Promise<string[]> => {
    const names = (await p.databases.list()) ?? []
    return names.map((n) => host.namespaceOf(n)).filter((n): n is string => n !== null)
  }

  /** wipeNamespace(ns), layers 1 to 7 */
  const wipeNamespace = async (ns: string): Promise<void> => {
    host.forget(ns)
    for (const name of host.databaseNames(ns)) await p.databases.remove(name)
    await p.vault.wipe(ns)
    await p.biometric.remove(ns)
    // notifications before the prefs of ns: a platform may keep their namespace only there (native ID
    // table), and a process end in between must not lose it (review 432 R2-4)
    const cancelled = await p.notifications.cancelNamespace(ns)
    const removed = await p.notifications.removeDelivered(ns)
    // the prefs of ns stay until the notifications are confirmed gone: the next wipe still finds them,
    // and the verification reports both (review 432 R3-3)
    if (cancelled.ok && removed.ok) for (const k of p.prefs.keys(nsPrefs(ns))) p.prefs.remove(k)
  }

  /** verifyNamespaceWiped(ns), layer 8: the names of every surviving layer */
  const verifyNamespace = async (ns: string): Promise<string[]> => {
    const out: string[] = []
    const all = await p.databases.list()
    if (all) for (const n of all) if (n.includes(ns)) out.push(`indexeddb:${n}`)
    if (!all) for (const n of host.databaseNames(ns)) if (await p.databases.exists(n)) out.push(`indexeddb:${n}`)
    if (!(await p.vault.verifyWiped(ns))) out.push(`vault:${ns}`)
    if ((await keystoreHas(ns)) !== false) out.push(`keystore:${ns}`)
    if (!(await p.notifications.verifyNone(ns))) out.push(`notifications:${ns}`)
    for (const k of p.prefs.keys(nsPrefs(ns))) out.push(`prefs:${k}`)
    return out
  }

  /** global layers 9 to 13, only for a full delete, after wipeNamespace(ns) */
  const wipeGlobal = async (ns: string): Promise<void> => {
    await p.session.wipe()
    // notifications before the prefs: a platform may keep their namespaces only there (review 432 R4-2)
    // scheduled and delivered ones of every known namespace, not only of ns (N12, review 432 CodeRabbit)
    const spaces = new Set([ns, ...(await known())])
    for (const n of await p.notifications.list()) if (n.ns !== null) spaces.add(n.ns)
    for (const k of p.prefs.keys()) if (k.endsWith(NOTIFY_IDS)) spaces.add(k.slice(0, -NOTIFY_IDS.length))
    let cancelled = true
    for (const s of spaces) {
      if (!(await p.notifications.cancelNamespace(s)).ok) cancelled = false
      await p.notifications.removeDelivered(s)
    }
    // and every scheduled one whose namespace cannot be told (round 6 R1-5)
    if (!(await p.notifications.cancelNamespace(ALL_NAMESPACES)).ok) cancelled = false
    const removed = await p.notifications.removeDelivered(ALL_NAMESPACES)
    if (cancelled && removed.ok && (await p.notifications.verifyNone(ALL_NAMESPACES))) for (const k of p.prefs.keys()) p.prefs.remove(k)
    await clipboardBarrier()
  }

  /** the barrier of the clipboard lane: also a copy that waits or still runs (#433); part of the
   *  global layers, and run by delete.wipe in any case, also when a layer before it threw */
  const clipboardBarrier = async (): Promise<void> => {
    if (p.clipboard.holdsAppCopy()) await p.clipboard.clear()
  }

  /** verification of a full delete: layer 8 of ns and the global layers */
  const verifyAll = async (ns: string): Promise<string[]> => {
    const out = await verifyNamespace(ns)
    for (const k of p.prefs.keys()) out.push(`prefs:${k}`)
    out.push(...(await p.session.survivors()))
    if (!(await p.notifications.verifyNone(ALL_NAMESPACES))) out.push('notifications')
    // a copy that may still land is never verified (#433); one the app could not overwrite (review 432 R4-4)
    if (p.clipboard.unsettled()) out.push('clipboard:unverifiable')
    else if (p.clipboard.holdsAppCopy()) out.push('clipboard')
    for (const other of await p.vault.namespaces()) out.push(`vault:${other}`)
    return out
  }

  /** what is left of Gen 2 (architecture §4.2 "Gen-2-Reset") */
  const legacySurvivors = async (): Promise<string[]> => {
    const out = [...(await p.legacy.survivors())]
    try {
      if (await p.biometric.hasLegacy()) out.push('keystore:wot_biometric_key')
    } catch {
      out.push('keystore:wot_biometric_key (not verifiable)')
    }
    return out
  }

  /** every namespace the vault or the host still knows */
  const known = async (): Promise<Set<string>> => new Set([...(await p.vault.namespaces()), ...(await hostNamespaces())])

  return { keystoreHas, offer, lockInfo, wipeNamespace, verifyNamespace, wipeGlobal, clipboardBarrier, verifyAll, legacySurvivors, known }
}
