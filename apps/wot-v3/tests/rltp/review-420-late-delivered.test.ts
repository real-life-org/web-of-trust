// @vitest-environment node
// Review 420, CodeRabbit (transport.ts, routing after `accepted`): Delivery §6.1 defines `accepted` as
// durable buffering and `delivered` as a valid acknowledgement; a late valid acknowledgement turns
// `failed` into `delivered`. The deposit leaves the lease once taken or failed (R23-1); the routing of
// its digest stays with the lease that deposited it until `delivered` or until that lease stops
// (TRANSPORT.md rule 6).
import { expect, it } from 'vitest'
import { shareTransport, type Transport, type TransportHandlers } from '../../src/adapters/rltp/transport'
import { writableStore } from '../../src/port'
import { virtualClock as transportClock } from '../../src/platform/fake'
/** the device clock of the shared transport's retries (#430) */
const tclock = transportClock(0, 'UTC')

type Deposit = Parameters<Transport['submit']>[0][number]
type Report = Parameters<TransportHandlers['report']>[0]
const online = () => writableStore({ network: 'online' as const, carrier: 'connected' as const })

const setup = () => {
  let registration!: TransportHandlers
  const seen: Report[] = []
  const shared = shareTransport({ status: online(), start(h) { registration = h }, stop() {}, submit() {}, withdraw() {} }, tclock)
  const lease = shared.lease()
  lease.start({ envelope: async () => 'taken', report(r) { seen.push(r) } })
  lease.activate()
  const o = { digest: 'doc', envelope: { sealed: true } } as unknown as Deposit
  expect(lease.submit([o])).toBe(true)
  return { carrier: () => registration, seen, lease, o, shared }
}

it('accepted then delivered reach the holder in turn; the routing ends with delivered', () => {
  const { carrier, seen, lease, o, shared } = setup()
  carrier().report({ digest: o.digest, status: 'accepted' }, o)
  carrier().report({ digest: o.digest, status: 'delivered', late: false })
  // delivered is final (§6.1: monotone except failed → delivered): nothing after it is routed any more
  carrier().report({ digest: o.digest, status: 'failed', reason: 'unroutable' })
  expect(seen.map((r) => r.status)).toEqual(['accepted', 'delivered'])
  lease.stop()
  expect(shared.faults()).toEqual([])
})

it('accepted, failed, then a late delivered reach the holder in turn (§6.1)', () => {
  const { carrier, seen, lease, o } = setup()
  carrier().report({ digest: o.digest, status: 'accepted' }, o)
  carrier().report({ digest: o.digest, status: 'failed', reason: 'expired-by-adapter-policy' })
  // the deposit has left the lease; the late acknowledgement needs only the digest's depositor
  carrier().report({ digest: o.digest, status: 'delivered', late: true })
  expect(seen.map((r) => r.status)).toEqual(['accepted', 'failed', 'delivered'])
  lease.stop()
})

it('a failed deposit keeps its routing: a late delivered reaches the holder after further deposits', () => {
  const { carrier, seen, lease, o } = setup()
  carrier().report({ digest: o.digest, status: 'failed', reason: 'unroutable' }, o)
  const other = { digest: 'other' } as Deposit
  lease.submit([other])
  carrier().report({ digest: other.digest, status: 'accepted' }, other)
  carrier().report({ digest: o.digest, status: 'delivered', late: true })
  expect(seen.map((r) => `${r.digest}:${r.status}`)).toEqual(['doc:failed', 'other:accepted', 'doc:delivered'])
  lease.stop()
})

it('the routing ends when the lease stops: a delivered afterwards reaches no lease', () => {
  const { carrier, seen, lease, o } = setup()
  carrier().report({ digest: o.digest, status: 'accepted' }, o)
  const old = carrier()
  lease.stop()
  old.report({ digest: o.digest, status: 'delivered', late: false })
  expect(seen.map((r) => r.status)).toEqual(['accepted'])
})
