# Investigation: Multi-Device Silent Write-Loss

**Type:** runtime investigation (instrument-and-report, NO fix). **Status:** breakage class
proven; exact Yjs-removal site is an open sub-question for the fix-model.

## TL;DR / Verdict

The silent write-loss the Festival-Scale-Stress runner surfaced with `DUAL_DEVICE_USERS > 0` is
a **client-side local-doc-state loss**, NOT a log-sync/broker protocol drop:

- The lost write **enters the author's own CRDT doc** (`localAfterWrite = true` right after
  `handle.transact`) and is **gone from that same doc at run end** (`authorLocalHas = false`) — the
  doc dropped the mutation **before it was ever flushed to a durable log entry**.
- The broker therefore **never receives** the mutation; every entry the client *does* send is
  stored fine (broker disposition `accept-new-entry`, no rejects, no idempotent-drops).
- All three directive suspects are **falsified** (see below): it is not a swallowed send-timeout,
  not a swallowed error-frame, not a thid/messageId misattribution.

The trigger is the **harness's dual-device model**: two same-DID `YjsReplicationAdapter` instances
sharing a single mutable `keyManagement` **and** `metadataStorage`, plus the multi-device
same-DID full-state exchange. This is not a supported real multi-device configuration (real second
devices carry their own metadata, synced via PersonalDoc), so **the finding does not demonstrate a
product/broker bug on the log-sync path**. Whether real multi-device has a *separate* issue is
**untested** by this harness.

## Minimal reproducer

```bash
STRESS_TRACE=1 USERS=4 SPACES=1 DUAL_DEVICE_USERS=2 BURST_MSGS_PER_DEVICE=5 \
  pnpm --filter @web_of_trust/e2e-log-sync stress
```

Loses ~1 write per run (timing-dependent; ~3–4 of every 5 seeds lose 1, occasionally 0 or 2).
`DUAL_DEVICE_USERS=0` is always clean. The lost write is always a device's **first** stress write
(`n = 1`; second devices → log seq 0, primary/creator devices → their next seq after
createSpace/addMember). Authors are **both** second-devices AND primary-devices of dual users.

## Method

1. **Committed runner trace (`STRESS_TRACE=1`, `stress/trace.ts`):** per write, records
   `writeId → (deviceId, seq)` by polling `docLogStore.getKnownHeads` after `transact`, plus
   `localAfterWrite` (is the writeId in the author's own doc immediately after transact?). At run
   end each MISSING writeId is classified against runner-observable state (incl. re-reading the
   author's own doc → `authorLocalHas`). Output: `stress-artifacts/<ts>/trace.jsonl`.
2. **Temporary core traces (env-gated, now REVERTED — `git status` clean except the runner):**
   - `WOT_TRACE_WRITES=1` in `YjsReplicationAdapter.writeLocalUpdateViaLog` — logged the per-write
     outcome (`logged-and-sent` + seq / `dropped-no-content-key` / `append-failed` /
     `send-failed-swallowed` / `no-coordinator-content-fallback`) and every `doc.on('update')`
     firing.
   - `RELAY_TRACE_ENTRIES=1` in `relay.ts` after `appendEntry` — logged `(docId, deviceId, seq,
     keyGeneration, disposition, contentHash)` for every received log-entry frame.

## Evidence chain (one missing writeId, end-to-end)

For a losing write (e.g. `…647b57db23:1`, a dual-user PRIMARY device):

| Signal | Value | Meaning |
|---|---|---|
| `localAfterWrite` (runner) | **true** | the writeId WAS in the author's own doc right after `transact` |
| `authorLocalHas` (runner, at end) | **false** | it is GONE from that same doc at run end |
| doc-creation trace (`dtrace`) | **1** | the doc was NOT rebuilt/replaced (single `new Y.Doc()` for this device+space) |
| `[wtrace]` outcome | `logged-and-sent`, seq 4 | the writes the client DID emit went out normally (no swallow) |
| relay `[btrace]` for the device | all `accept-new-entry` | the broker stored everything it received; NO reject, NO idempotent-drop |
| wire audit | writeId absent from the reconstructed CRDT | consistent: the mutation never became an entry, so nothing carries it |

**Conclusion:** the mutation was present in the live doc, then removed from that same (non-rebuilt)
doc before it was encoded to a log entry → it never left the client. Uniform class across seeds:
`local-doc-lost-after-write`.

## Falsification of the pre-grounded suspects

- **Suspect 1 — write-send receipt-timeout, swallowed, no retry trigger:** FALSIFIED. `[wtrace]`
  showed the emitted writes as `logged-and-sent` (send resolved with a receipt); no
  `send-failed-swallowed`, and the losing write never reached `sendLogEntryEnvelope` at all (it was
  gone from the doc first).
- **Suspect 2 — swallowed broker error-frame (e.g. `DEVICE_NOT_REGISTERED`):** FALSIFIED. Broker
  `[btrace]` shows only `accept-new-entry` for the device; no error-frame path was taken, and the
  runner's error-frame tally was empty.
- **Suspect 3 — thid/messageId misattribution (same-adapter stale in-flight):** FALSIFIED for this
  loss. The write never produced an in-flight send, so there is nothing to misattribute.
- **`never-local-logged` / `local-logged-pending` (v4 classes):** NOT the class here — the emitted
  writes DID get seqs and were stored; the loss is upstream, at the doc.

## Two instrument bugs found (and fixed) — a methodology note

The runner's own trace mis-classified the loss twice before the evidence converged; both are fixed
in `stress/trace.ts` + `stress/run-stress.ts`:

1. **seq-0 off-by-one:** the seq detector used `getKnownHeads[dev] ?? 0` with a `> beforeMax`
   threshold. Since seq numbering starts at **0**, a first write that got seq 0 was
   indistinguishable from "no seq" → mislabeled `never-local-logged`. Fixed with a `-1` sentinel.
2. **racy `writeId → seq` mapping:** mapping a writeId to `max(getKnownHeads[dev])` after transact
   is unreliable when non-stress updates (membership/rotation) bump the head concurrently → it
   attributed a real doc-loss to a stored neighbour seq, mislabeling it `acked-but-broker-absent`.
   The definitive discriminator is the doc-level `localAfterWrite` + `authorLocalHas` pair, which is
   seq-independent.

Lesson: trust the instrument only after it survives its own adversarial check — the first "class"
was an artifact of the tracer, not the system.

## Runner-artifact vs. real-protocol

- The loss is **structurally tied to the harness dual-device model**: the second device is built
  sharing the primary's **mutable** `keyManagement` + `metadataStorage` and depends on
  `requestSync('__all__')` (metadata restore) to learn the space at all — an A/B with a separate
  `metadataStorage` (`STRESS_DUAL_SHARE_META=0`) makes the second device non-functional (it can
  never learn the space), confirming the shared store is load-bearing in this model.
- Sharing a single mutable metadata/key store between two independent same-DID adapters is **not a
  supported real multi-device configuration**. Real devices each hold their own stores, synced via
  PersonalDoc/vault. So this specific loss does **not** prove a broker/log-sync product bug.

## Open sub-question (for the fix-model, not this investigation)

The exact Yjs-level site where the live doc loses the just-written key **without a rebuild** is not
yet pinned (candidates: the multi-device same-DID full-state exchange / apply path, or a
merge/reset interaction driven by the shared stores). The committed `STRESS_TRACE` runner is the
harness to pin it. Recommended next step **before** treating this as a product bug: re-model
dual-device properly (each device its own PersonalDoc-synced metadata) and re-run — if the loss
disappears, it was the harness model; if it persists, escalate to a product investigation of the
multi-device doc-apply path.

## Not covered

- A product fix (out of scope — breakage class + mechanism suffice per the directive).
- Real PersonalDoc-synced multi-device (the harness cannot model it today).
