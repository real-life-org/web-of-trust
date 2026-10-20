// Test entry of the real adapter: what tests need from the library goes through here, so that only
// src/adapters/rltp imports it (architecture §1.1). Not imported by the app.
export { storeContract } from '@real-life/trust-protocol'

import { shareTransport, type Lease, type Transport } from './transport'

/** a session opened alone in a test: the only opening on its device transport, in use from the start */
export function leaseInUse(t: Transport): Lease {
  const lease = shareTransport(t).lease()
  lease.activate()
  return lease
}
