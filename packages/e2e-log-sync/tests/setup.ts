import 'fake-indexeddb/auto'

// The replication adapters run background sync loops; on teardown they may log
// expected async FAILURE noise (offline sends, callback errors, restore-clone
// re-write retries) AFTER the test that started them finished. Left unsuppressed
// these race vitest worker teardown and surface as spurious EnvironmentTeardownError.
// Suppress ONLY this known async-teardown failure noise — and only when a
// component-prefixed line ALSO carries a failure indicator, so an unexpected
// component log (without a failure keyword) still surfaces. Real regressions fail
// via assertions regardless; console suppression never affects test outcomes.
const COMPONENT = '\\[(EncryptedSync|Replication|ReplicationAdapter|YjsReplication|AutomergeReplication|Discovery|InboxReception)\\]'
const FAILURE_NOISE = '(failed|error|offline|retry on reconnect|not durable|disconnect|AUTHOR_MISMATCH|CAPABILITY_|SEQ_COLLISION)'
const EXPECTED_SYNC_NOISE = new RegExp(
  `^${COMPONENT}[^\\n]*${FAILURE_NOISE}` +
    `|^Message callback error` +
    `|must call connect\\(\\) before send` +
    `|PendingMessageNotDurableError` +
    `|^\\[WebSocket\\]`,
  'i',
)

for (const level of ['log', 'warn', 'error'] as const) {
  const original = console[level].bind(console)
  console[level] = (...args: unknown[]) => {
    if (typeof args[0] === 'string' && EXPECTED_SYNC_NOISE.test(args[0])) return
    original(...args)
  }
}
