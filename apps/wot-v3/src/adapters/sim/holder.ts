// Holder host of the simulation (architecture §3.2): the identity runtime opens "holders" here. The
// simulated holder keeps the profile and the terms consent per namespace, applies setProfile and
// acceptTerms idempotently per actId, registers its database names on the fake device so the wipe
// inventory has something real to remove and verify, and feeds the own name into the world.

import type { HolderHandle, HolderHost } from '../identity/host'
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
): HolderHost & { current(): string | null; isOpen(ns: string): boolean; openHandles(): readonly HolderHandle[]; log: string[] } {
  /** the holder whose profile the world shows (the active one) */
  let current: string | null = null
  /** the open openings, in order; each handle is its own opening */
  const open = new Set<HolderHandle>()
  const log: string[] = []
  const isOpen = (ns: string) => [...open].some((h) => h.ns === ns)
  const drop = (h: HolderHandle) => {
    open.delete(h)
    if (current !== null && !isOpen(current)) current = [...open].at(-1)?.ns ?? null
  }
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
      const holder: HolderHandle = { ns, kind: 'holder-handle' }
      open.add(holder)
      current = ns
      world.apply({ type: 'set-me', name: rec.name ?? '', anchorShort: rec.anchorShort })
      return { kind: 'ok', holder }
    },
    async init(holder, inputs) {
      if (!open.has(holder)) return
      const ns = holder.ns
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
    async acceptTerms(holder, version, actId) {
      if (!open.has(holder)) return
      const rec = holders.get(holder.ns)
      if (rec && !rec.actIds.has(actId)) {
        rec.terms = version
        rec.actIds.add(actId)
      }
    },
    anchorShort: (ns) => holders.get(ns)?.anchorShort ?? null,
    isOpen,
    openHandles: () => [...open],
    async quiesce(holder) {
      if (open.has(holder)) log.push(`quiesce:${holder.ns}`)
    },
    async deregister(holder, mode) {
      const n = open.has(holder) ? (holders.get(holder.ns)?.relationships ?? 0) : 0
      log.push(`deregister:${mode}`)
      return mode === 'run' ? { done: n, failed: 0 } : { done: 0, failed: n }
    },
    async seal(holder) {
      if (open.has(holder)) log.push(`seal:${holder.ns}`)
    },
    async close(holder) {
      if (!open.has(holder)) return
      log.push(`close:${holder.ns}`)
      drop(holder)
    },
    forget(ns) {
      holders.delete(ns)
      for (const h of [...open]) if (h.ns === ns) drop(h)
    },
  }
}
