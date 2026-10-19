// SeedVaultPort after architecture §5.2 over a small transactional key-value backend (IndexedDB in
// the app, an in-memory map in tests and the harness). Two stores: `vaults` (key ns) and `meta`
// (`active`, `resume`, `init:<ns>`, `bioUnusable:<ns>`). Whatever has to change together is one
// write transaction over both stores. WebCrypto runs outside transactions (an IndexedDB transaction
// commits itself at the next idle task); a rewrite checks inside its transaction that the record
// is still the one it opened (compare by IV), so a concurrent writer makes it fail, not overwrite.
//
// Grundgerüst after wot-core `IndexedDbIdentitySeedVault` (connection registry, whole-DB delete),
// without its session-key store: unlocking means passphrase or biometrics every time (§5.2).

import type { ClockPort, EntropyPort, ProtectionMode, ResumeMarker, SealedInit, SeedVaultPort, VaultHead } from '../ports'
import { classify, open, seal, TARGET_ITERATIONS, type VaultPayload, type VaultRecord } from './format'

export type VaultStore = 'vaults' | 'meta'

export interface VaultTx {
  get(store: VaultStore, key: string): Promise<unknown>
  keys(store: VaultStore): Promise<readonly string[]>
  put(store: VaultStore, key: string, value: unknown): void
  delete(store: VaultStore, key: string): void
}

export interface VaultBackend {
  /** runs `fn` in one read-only transaction */
  read<T>(fn: (tx: VaultTx) => Promise<T>): Promise<T>
  /** runs `fn` in one read-write transaction; resolves after the commit, rejects if it aborted */
  write<T>(fn: (tx: VaultTx) => Promise<T>): Promise<T>
}

export interface SeedVaultOptions {
  readonly clock: ClockPort
  readonly entropy: EntropyPort
  readonly subtle?: SubtleCrypto
  /** rounds for new writes; records with fewer are rewritten after a successful open (§5.2 migration) */
  readonly iterations?: number
}

/** Thrown inside a write transaction to abort it with a known reason. */
class Conflict extends Error {}

const INIT = (ns: string) => `init:${ns}`
const BIO = (ns: string) => `bioUnusable:${ns}`

function asRecord(v: unknown): VaultRecord | null {
  return v !== undefined && v !== null && classify(v) === 'v3' ? (v as VaultRecord) : null
}

export function createSeedVault(backend: VaultBackend, opts: SeedVaultOptions): SeedVaultPort {
  const subtle = opts.subtle ?? globalThis.crypto.subtle
  const target = opts.iterations ?? TARGET_ITERATIONS

  const sealFor = async (
    ns: string,
    protection: ProtectionMode,
    password: Uint8Array,
    payload: VaultPayload,
    createdAt: number | null,
  ): Promise<VaultRecord> => {
    const now = opts.clock.now()
    return seal(subtle, {
      ns,
      protection,
      iterations: target,
      createdAt: createdAt ?? now,
      updatedAt: now,
      salt: opts.entropy.bytes(16),
      iv: opts.entropy.bytes(12),
      password,
      payload,
    })
  }

  const readRecord = (ns: string): Promise<unknown> => backend.read((tx) => tx.get('vaults', ns))

  /** Replaces the record of ns if it still is `expected` (same IV). false on conflict. */
  const replace = async (ns: string, expected: VaultRecord, next: VaultRecord): Promise<boolean> => {
    try {
      await backend.write(async (tx) => {
        const current = asRecord(await tx.get('vaults', ns))
        if (!current || current.iv !== expected.iv) throw new Conflict('vault changed')
        tx.put('vaults', ns, next)
      })
      return true
    } catch (e) {
      if (e instanceof Conflict) return false
      throw e
    }
  }

  const openRecord = async (ns: string, password: Uint8Array): Promise<{ record: VaultRecord; payload: VaultPayload } | null> => {
    const record = asRecord(await readRecord(ns))
    if (!record) return null
    const payload = await open(subtle, record, password)
    return payload ? { record, payload } : null
  }

  const vault: SeedVaultPort = {
    async exists(ns) {
      const raw = await readRecord(ns)
      if (raw === undefined || raw === null) return 'none'
      return classify(raw)
    },

    async head(ns) {
      const record = asRecord(await readRecord(ns))
      return record ? (record.head as VaultHead) : null
    },

    async create(ns, payload, password, protection, init, marker) {
      const record = await sealFor(ns, protection, password, payload, null)
      await backend.write(async (tx) => {
        tx.put('vaults', ns, record)
        tx.put('meta', INIT(ns), init)
        tx.put('meta', 'resume', marker)
      })
    },

    async open(ns, password) {
      const opened = await openRecord(ns, password)
      if (!opened) return null
      const { record, payload } = opened
      // Migration (§5.2): fewer rounds than the target → rewrite with the same password, same head.
      // Best effort: a failed rewrite (quota, aborted transaction) must not fail an open whose
      // password already decrypted the record; the next open tries again.
      if (record.head.kdf.iterations < target) {
        try {
          const next = await sealFor(ns, record.head.protection, password, payload, record.head.createdAt)
          await replace(ns, record, next)
        } catch {
          // keep the old record
        }
      }
      return payload
    },

    async rewrap(ns, oldPassword, newPassword, protection) {
      const opened = await openRecord(ns, oldPassword)
      if (!opened) return false
      const next = await sealFor(ns, protection, newPassword, opened.payload, opened.record.head.createdAt)
      return replace(ns, opened.record, next)
    },

    async setProtection(ns, protection, password) {
      const opened = await openRecord(ns, password)
      if (!opened) return false
      const next = await sealFor(ns, protection, password, opened.payload, opened.record.head.createdAt)
      return replace(ns, opened.record, next)
    },

    async init(ns) {
      const v = await backend.read((tx) => tx.get('meta', INIT(ns)))
      return (v as SealedInit | undefined) ?? null
    },

    async bioUnusable(ns) {
      return (await backend.read((tx) => tx.get('meta', BIO(ns)))) === true
    },

    async setBioUnusable(ns, v) {
      await backend.write(async (tx) => {
        if (v) tx.put('meta', BIO(ns), true)
        else tx.delete('meta', BIO(ns))
      })
    },

    async active() {
      const v = await backend.read((tx) => tx.get('meta', 'active'))
      return typeof v === 'string' ? v : null
    },

    async activate(ns, marker) {
      await backend.write(async (tx) => {
        tx.put('meta', 'active', ns)
        tx.delete('meta', INIT(ns))
        if (marker) tx.put('meta', 'resume', marker)
        else tx.delete('meta', 'resume')
      })
    },

    async resume() {
      const v = await backend.read((tx) => tx.get('meta', 'resume'))
      return (v as ResumeMarker | undefined) ?? null
    },

    async setResume(m) {
      await backend.write(async (tx) => {
        if (m) tx.put('meta', 'resume', m)
        else tx.delete('meta', 'resume')
      })
    },

    async wipe(ns) {
      await backend.write(async (tx) => {
        tx.delete('vaults', ns)
        tx.delete('meta', INIT(ns))
        tx.delete('meta', BIO(ns))
        // N6: the active pointer only goes when it still points at ns, checked in this transaction.
        if ((await tx.get('meta', 'active')) === ns) tx.delete('meta', 'active')
      })
    },

    async verifyWiped(ns) {
      return backend.read(async (tx) => {
        const left = await Promise.all([
          tx.get('vaults', ns),
          tx.get('meta', INIT(ns)),
          tx.get('meta', BIO(ns)),
          tx.get('meta', 'active'),
        ])
        return left[0] === undefined && left[1] === undefined && left[2] === undefined && left[3] !== ns
      })
    },

    async namespaces() {
      return backend.read(async (tx) => {
        const out = new Set(await tx.keys('vaults'))
        for (const k of await tx.keys('meta')) {
          const m = /^(?:init|bioUnusable):(.+)$/.exec(k)
          if (m?.[1]) out.add(m[1])
        }
        return [...out].sort()
      })
    },
  }
  return vault
}
