// Store foundation and snapshot semantics (architecture §2.1).
//
// The rules every adapter keeps (checked by tests/port-contract.ts):
//  1. get() is synchronous, never throws, triggers no loading and returns deeply frozen values.
//  2. Two get() without a notification in between return ===-equal values.
//  3. Structural sharing: unchanged sub-objects keep their reference.
//  4. subscribe notifies only when the reference of get() changed; notifications are batched per microtask.
//  5. One bundle, one revision (the adapter publishes all stores of a bundle together).
//  6. Atomic swap: all caches are swapped first, then every changed store notifies in the same microtask.

import type { AppError } from './errors'

/** A synchronously readable, immutable value. */
export interface ReadStore<T> {
  get(): T
  subscribe(onChange: () => void): () => void
}

/** Opaque revision of a projection bundle, ordered by generation, then core commitSeq, then app seq. */
export type Revision = string & { readonly __brand: 'Revision' }

export type Loadable<T> =
  | { readonly status: 'loading' }
  | { readonly status: 'ready'; readonly value: T; readonly asOf: Revision }
  | { readonly status: 'error'; readonly error: AppError; readonly last?: T }

/** For store families: the same instance per key while referenced. */
export interface StoreFamily<K extends string, T> {
  (key: K): ReadStore<T>
}

// ── Helpers (values) ────────────────────────────────────────────────────────

export const LOADING: { readonly status: 'loading' } = Object.freeze({ status: 'loading' as const })

export function ready<T>(value: T, asOf: Revision): Loadable<T> {
  return deepFreeze({ status: 'ready' as const, value, asOf })
}

export function revision(generation: number, commitSeq: number, appSeq: number): Revision {
  return `${generation}:${commitSeq}:${appSeq}` as Revision
}

/** Freezes a value and everything reachable from it. Returns the same reference. */
export function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return value
  for (const key of Reflect.ownKeys(value)) {
    deepFreeze((value as Record<PropertyKey, unknown>)[key])
  }
  return Object.freeze(value)
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  if (v === null || typeof v !== 'object') return false
  const proto = Object.getPrototypeOf(v)
  return proto === Object.prototype || proto === null
}

function keyOf(v: unknown): string | null {
  if (!isPlainObject(v)) return null
  const k = v.id ?? v.key
  return typeof k === 'string' ? `${String(v.kind ?? '')}|${k}` : null
}

/**
 * Structural sharing (rule 3): returns `next`, but every part that is structurally equal to the
 * corresponding part of `prev` is replaced by the `prev` reference. Array elements are matched by
 * their `id`/`key` field when they have one, otherwise by index. If nothing changed, returns `prev`.
 */
export function structuralShare<T>(prev: T, next: T): T {
  if (Object.is(prev, next)) return prev
  if (Array.isArray(prev) && Array.isArray(next)) {
    const byKey = new Map<string, unknown>()
    for (const p of prev) {
      const k = keyOf(p)
      if (k !== null) byKey.set(k, p)
    }
    let same = prev.length === next.length
    const out = next.map((n, i) => {
      const k = keyOf(n)
      const candidate = k !== null ? byKey.get(k) : prev[i]
      const shared = candidate === undefined ? n : structuralShare(candidate, n)
      if (shared !== prev[i]) same = false
      return shared
    })
    return (same ? prev : out) as T
  }
  if (isPlainObject(prev) && isPlainObject(next)) {
    const prevKeys = Object.keys(prev)
    const nextKeys = Object.keys(next)
    let same = prevKeys.length === nextKeys.length
    const out: Record<string, unknown> = {}
    for (const k of nextKeys) {
      const shared = k in prev ? structuralShare(prev[k], next[k]) : next[k]
      if (shared !== prev[k] || !(k in prev)) same = false
      out[k] = shared
    }
    return (same ? prev : out) as T
  }
  return next
}

// Notifications of all writable stores are batched into one microtask, so a publish that sets
// several stores in one synchronous block swaps every cache before the first listener runs (rule 6).
let pending: Set<() => void> | null = null

function schedule(notify: () => void): void {
  if (pending === null) {
    pending = new Set()
    queueMicrotask(() => {
      const batch = pending ?? new Set<() => void>()
      pending = null
      for (const run of batch) run()
    })
  }
  pending.add(notify)
}

export interface WritableStore<T> extends ReadStore<T> {
  /** Swaps the cache (with structural sharing and deep freeze); notifies in the next microtask if the reference changed. */
  set(next: T): void
}

/** Store helper for adapters: holds a frozen value and batches notifications per microtask. */
export function writableStore<T>(initial: T): WritableStore<T> {
  let value = deepFreeze(initial)
  const listeners = new Set<() => void>()
  const notify = (): void => {
    for (const l of [...listeners]) l()
  }
  return {
    get: () => value,
    subscribe(onChange) {
      listeners.add(onChange)
      return () => {
        listeners.delete(onChange)
      }
    },
    set(next) {
      const shared = deepFreeze(structuralShare(value, next))
      if (shared === value) return
      value = shared
      schedule(notify)
    },
  }
}
