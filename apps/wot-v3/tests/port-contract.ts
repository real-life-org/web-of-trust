// Port contract (architecture §2.1): one suite, run against every adapter. The scaffold runs it
// against the simulation; the real adapter joins with its runtime (tests/port-contract.rltp.test.ts).
// A shared contract can confirm the same wrong assumption in both adapters; it is one of several
// test levels (architecture §7.4), not the only one.
import { describe, expect, it } from 'vitest'
import type { AppPort, ConversationKey, Loadable, ReadStore } from '../src/port'

export interface ContractSubject {
  readonly port: AppPort
  /** a conversation key that exists */
  readonly key: ConversationKey
  /** another conversation key that exists and is untouched by `change` */
  readonly otherKey: ConversationKey
  /** makes the core change exactly one conversation (`key`), e.g. a received message */
  change(): void
}

export interface ContractOptions {
  /** a subject whose first bundle is still pending */
  readonly pending?: () => { port: AppPort; release(): void }
}

const tick = () => new Promise<void>((r) => queueMicrotask(r))

function countNotifications<T>(store: ReadStore<T>): { count: () => number; stop: () => void } {
  let n = 0
  const stop = store.subscribe(() => n++)
  return { count: () => n, stop }
}

function readyValue<T>(l: Loadable<T>): T {
  if (l.status !== 'ready') throw new Error(`expected ready, got ${l.status}`)
  return l.value
}

export function portContract(name: string, make: () => ContractSubject, opts: ContractOptions = {}): void {
  describe(`port contract: ${name}`, () => {
    it('rule 1: get() is synchronous and returns deeply frozen values', () => {
      const { port, key } = make()
      const contacts = port.stores.contacts.get()
      expect(contacts.status).toBe('ready')
      expect(Object.isFrozen(contacts)).toBe(true)
      const list = readyValue(contacts)
      expect(Object.isFrozen(list)).toBe(true)
      expect(list.every((c) => Object.isFrozen(c) && Object.isFrozen(c.conversation))).toBe(true)
      const conv = readyValue(port.stores.conversation(key).get())
      expect(Object.isFrozen(conv.items)).toBe(true)
      expect(() => {
        ;(list as unknown as unknown[]).push(null)
      }).toThrow()
    })

    it('rule 2: two get() without a notification return the same reference', () => {
      const { port, key } = make()
      expect(port.stores.contacts.get()).toBe(port.stores.contacts.get())
      expect(port.stores.conversation(key).get()).toBe(port.stores.conversation(key).get())
      expect(port.stores.decisions.get()).toBe(port.stores.decisions.get())
    })

    it('rule 8: a store family returns the same store for the same key', () => {
      const { port, key } = make()
      expect(port.stores.conversation(key)).toBe(port.stores.conversation(key))
    })

    it('rule 4: notifies once per microtask, only when the reference changed', async () => {
      const s = make()
      const n = countNotifications(s.port.stores.contacts)
      const before = s.port.stores.contacts.get()
      s.change()
      s.change()
      expect(n.count()).toBe(0)
      await tick()
      expect(n.count()).toBe(1)
      expect(s.port.stores.contacts.get()).not.toBe(before)
      // nothing changed (the other conversation has nothing unread): no notification
      const settled = n.count()
      const unchanged = s.port.stores.contacts.get()
      s.port.trust.markRead(s.otherKey, Number.MAX_SAFE_INTEGER)
      await tick()
      expect(n.count()).toBe(settled)
      expect(s.port.stores.contacts.get()).toBe(unchanged)
      n.stop()
    })

    it('rules 5 and 6: one bundle, one revision; all caches swapped before the first notification', async () => {
      const s = make()
      const conv = s.port.stores.conversation(s.key)
      const seen: string[] = []
      const stop = s.port.stores.contacts.subscribe(() => {
        const a = s.port.stores.contacts.get()
        const b = conv.get()
        const d = s.port.stores.decisions.get()
        if (a.status === 'ready' && b.status === 'ready' && d.status === 'ready') seen.push(`${a.asOf}|${b.asOf}|${d.asOf}`)
      })
      s.change()
      await tick()
      stop()
      expect(seen).toHaveLength(1)
      const [a, b, d] = (seen[0] ?? '').split('|')
      expect(a).toBe(b)
      expect(a).toBe(d)
    })

    it('rule 3: structural sharing keeps untouched rows and conversations by reference', async () => {
      const s = make()
      const before = readyValue(s.port.stores.contacts.get())
      const otherBefore = s.port.stores.conversation(s.otherKey).get()
      s.change()
      await tick()
      const after = readyValue(s.port.stores.contacts.get())
      const changedId = s.key.slice(2)
      for (const row of after) {
        const prev = before.find((r) => r.id === row.id)
        if (row.id === changedId) expect(row).not.toBe(prev)
        else expect(row).toBe(prev)
      }
      expect(readyValue(s.port.stores.conversation(s.otherKey).get())).toBe(readyValue(otherBefore))
    })

    if (opts.pending) {
      it('rule 10: stores show loading until the first bundle, then switch together', async () => {
        const { port, release } = opts.pending!()
        expect(port.stores.contacts.get().status).toBe('loading')
        expect(port.stores.decisions.get().status).toBe('loading')
        release()
        await tick()
        expect(port.stores.contacts.get().status).toBe('ready')
        expect(port.stores.decisions.get().status).toBe('ready')
      })
    }
  })
}
