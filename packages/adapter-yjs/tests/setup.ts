import 'fake-indexeddb/auto'

// Test peers run their sync / discovery loops against a fake broker, so
// background operations log expected failures *asynchronously* — often after the
// test that started them has already finished. Left unsuppressed, these console
// calls race with vitest's worker teardown and surface as a spurious
// "EnvironmentTeardownError: Closing rpc while onUserConsoleLog was pending",
// failing the run even though every test passed. Drop only this known, expected
// noise; real failures surface via assertions, not these logs.
const EXPECTED_SYNC_NOISE =
  /^\[(EncryptedSync|Replication|ReplicationAdapter|YjsReplication|Discovery|InboxReception)\]|^Message callback error|must call connect\(\) before send|PendingMessageNotDurableError/

for (const level of ['log', 'warn', 'error'] as const) {
  const original = console[level].bind(console)
  console[level] = (...args: unknown[]) => {
    if (typeof args[0] === 'string' && EXPECTED_SYNC_NOISE.test(args[0])) return
    original(...args)
  }
}
