// Holder host of the simulation (architecture §3.2): the identity runtime opens "holders" here. The
// simulated holder keeps the profile and the terms consent per namespace, applies setProfile and
// acceptTerms idempotently per actId, registers its database names on the fake device so the wipe
// inventory has something real to remove and verify, and feeds the own name into the world.

import type { HolderHost } from '../identity/host'
import type { SimWorld } from './world'

export interface SimHolderRecord {
  name: string | null
  image: string | null
  terms: string | null
  readonly actIds: Set<string>
  anchorShort: string
  /** relationships the simulated transport would deregister on delete */
  relationships: number
}

/** Persistent part (outlives a runtime restart, like the fake device). */
export type SimHolders = Map<string, SimHolderRecord>

export const simDatabaseNames = (ns: string) => [`wot-v3-holder-${ns}`, `wot-v3-app-${ns}`]

function anchorShortOf(rootIkm: Uint8Array): string {
  const tail = [...rootIkm.slice(60, 64)].map((b) => b.toString(16).padStart(2, '0')).join('')
  return `z6Mk…${tail}`
}

export function simHolderHost(
  world: SimWorld,
  holders: SimHolders,
  databases: Set<string>,
  opts: { relationships?: number } = {},
): HolderHost & { current(): string | null; log: string[] } {
  /** the holder whose profile the world shows (the active one) */
  let current: string | null = null
  const open = new Set<string>()
  const log: string[] = []
  return {
    log,
    current: () => current,
    databaseNames: simDatabaseNames,
    namespaceOf(name) {
      const m = /^wot-v3-(?:holder|app)-(.+)$/.exec(name)
      return m?.[1] ?? null
    },
    async open(ns, keys) {
      log.push(`open:${ns}`)
      for (const n of simDatabaseNames(ns)) databases.add(n)
      let rec = holders.get(ns)
      if (!rec) {
        rec = { name: null, image: null, terms: null, actIds: new Set(), anchorShort: anchorShortOf(keys.rootIkm), relationships: opts.relationships ?? 0 }
        holders.set(ns, rec)
      }
      open.add(ns)
      current = ns
      world.apply({ type: 'set-me', name: rec.name ?? '', anchorShort: rec.anchorShort })
      return 'ok'
    },
    async init(ns, inputs) {
      const rec = holders.get(ns)
      if (!rec) throw new Error('init before open')
      if (inputs.profile && !rec.actIds.has(inputs.actIds.setProfile)) {
        rec.name = inputs.profile.name
        rec.image = inputs.profile.image ?? null
        rec.actIds.add(inputs.actIds.setProfile)
        log.push(`setProfile:${ns}`)
      }
      if (inputs.termsVersion && !rec.actIds.has(inputs.actIds.acceptTerms)) {
        rec.terms = inputs.termsVersion
        rec.actIds.add(inputs.actIds.acceptTerms)
        log.push(`acceptTerms:${ns}`)
      }
      if (current === ns) world.apply({ type: 'set-me', name: rec.name ?? '', anchorShort: rec.anchorShort })
    },
    async acceptTerms(ns, version, actId) {
      const rec = holders.get(ns)
      if (rec && !rec.actIds.has(actId)) {
        rec.terms = version
        rec.actIds.add(actId)
      }
    },
    anchorShort: (ns) => holders.get(ns)?.anchorShort ?? null,
    isOpen: (ns) => open.has(ns),
    async quiesce(ns) {
      log.push(`quiesce:${ns}`)
    },
    async deregister(ns, mode) {
      const n = holders.get(ns)?.relationships ?? 0
      log.push(`deregister:${mode}`)
      return mode === 'run' ? { done: n, failed: 0 } : { done: 0, failed: n }
    },
    async seal(ns) {
      log.push(`seal:${ns}`)
    },
    async close(ns) {
      log.push(`close:${ns}`)
      open.delete(ns)
      if (current === ns) current = [...open].at(-1) ?? null
    },
    forget(ns) {
      holders.delete(ns)
      open.delete(ns)
      if (current === ns) current = [...open].at(-1) ?? null
    },
  }
}
