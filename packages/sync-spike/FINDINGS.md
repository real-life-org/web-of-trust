# Sync-002 reliability spike — FINDINGS

**Date:** 2026-06-23
**Branch:** spec-vnext
**Verdict: GO.** (Hardened after a 6-dimension adversarial review — see "Review & hardening".)

All seven core tests are green under the `durable-log` (Sync-002) relay, the optional
Yjs cross-check passes, and both adversarial controls reproduce the historical
failures (they assert the failure and would flip to passing under the fixed design —
verified). The Sync-002 design as expressed by the vector-validated primitives in
`@web_of_trust/core/protocol` is sufficient to fix the two production-blocking bugs
(permanent space loss on cold reconstruction; the 5000+ outbox loop) without any new
crypto or new classifier logic.

```
Test Files  10 passed (10)
     Tests  22 passed (22)
```

## GO criteria — met

- **All 7 core tests green under `durable-log`.** 01 cold-reconstruction (HEADLINE),
  02 loop-safety, 03 catch-up, 04 multi-device, 05 restore-clone, 06 key-rotation,
  07 personal-doc. Plus 00 smoke, 08 yjs (optional), 09 granularity.
- **Controls reproduce the failures (teeth verified).**
  - 01 transient control: a fresh client gets nothing after ACK; reconstructed state
    `!=` original. Switched to `durable-log` the same scenario reconstructs fully —
    so the control genuinely detects the permanent-space-loss bug.
  - 02 naive control: a single user write cascades to 1000+ appends. With
    `naiveRebroadcast` off the same scenario produces exactly 1 append — so the
    control genuinely detects the outbox loop.

## What each failure mode needs from the design

- **Permanent space loss** is fixed by the **retained append-only log keyed by
  `(deviceId,seq)`** plus **heads-based catch-up**. An empty client with only the
  identity + membership + Space Content Key reconstructs the full space from
  `syncPage(docId, {})`. The transient queue (delete-on-ACK) cannot do this by
  construction — there is no per-doc history to serve.
- **The outbox loop** is fixed by two independent guards, either of which alone bounds
  the system: (1) clients never re-broadcast entries they receive (loop-freedom is
  structural — `receive()` has no write path; test 02 "loop-free" + "contrast"); (2) the
  broker dedups exact retransmissions by `(deviceId,seq,contentHash)` via
  `classifyBrokerSeqCollision` (`idempotent-retransmission` -> no re-store, no
  re-broadcast; test 02 "broker dedup" exercises this branch directly: a replayed
  identical entry leaves `logLength` and `totalBroadcasts` unchanged). The loop only
  explodes when a client actively re-emits observed state as *new* writes (fresh seqs)
  — an observe->write feedback path the broker correctly accepts (the naive control
  proves `appends = 1 + budgetA + budgetB`, i.e. genuinely unbounded without the test's
  safety cap). The lesson: **the loop guard must live in the client write path (do not
  turn observations into writes); broker dedup only bounds exact retransmissions, not
  the feedback loop.**

## Design observations (no blockers)

1. **The deterministic-nonce restore hazard is real and is correctly fenced.** The
   nonce is `SHA-256(deviceId|seq)[0:12]`, so re-using a `(deviceId,seq)` under the
   same Space Content Key with *different* plaintext is AES-GCM nonce reuse. The
   broker's `classifyBrokerSeqCollision` rejects the divergent second entry
   (`SEQ_COLLISION_DETECTED`, `clientHint: restore-clone-required`) **before** it is
   ever stored, so the reused nonce never encrypts two different plaintexts in the
   durable log (test 05a asserts the log still holds the original content). The
   client-side `classifyLocalBrokerSeqConsistency` independently flags
   `restore-clone-required` when `brokerSeq > localSeq`. The correct remedy is a
   **new `deviceId`** after restore (test 05b), which has a fresh seq space and never
   collides. **Implication for production:** a client MUST reserve its next seq
   durably (or mint a new `deviceId` on any restore-from-backup) — an optimistic local
   seq must survive a crash, otherwise a rewound client will keep hitting rejections.
   The spike models this with an optimistic-reserve-then-rollback-on-reject seq.
   **One residual exposure surface** (flagged by review, worth a note for the broker
   slice): in the client model the rewound-divergent entry is still *encrypted with the
   reused deterministic nonce and transmitted to the broker* before the broker rejects
   it — only storage and re-broadcast are prevented. A passive observer of the
   broker-bound channel could therefore capture two ciphertexts sharing a nonce even
   though only one is ever retained. Production should reject the seq at the boundary
   (or treat the relay-bound transport as a nonce-reuse exposure surface), not rely
   solely on post-receipt rejection.

2. **A snapshot is a checkpoint, never a log replacement — and the coverage-heads
   optimization is real and load-bearing.** `classifySnapshotDisposition` returns
   `markSnapshotProcessed: false` in every branch. With coverage-heads it is
   `catch-up-optimization-eligible`; without heads it is only `crdt-merge-helper-only`
   and still requires `sync-request-log-catch-up`. Test 01 PLAN-B now *drives* the
   restore from that disposition (not just asserts on it) and demonstrates the actual
   optimization: the snapshot persists **full registers** (value + Lamport + deviceId,
   like a real CRDT snapshot / Yjs `encodeStateAsUpdate`), the restored client seeds
   its heads from the coverage-heads, and `catchUp()` then fetches **only the
   post-snapshot entries** (`appliedCount === 2`, not the full log of 4) yet still
   deep-converges to the live `finalHash`, including a post-snapshot *overwrite* of a
   snapshot key. A companion assertion proves the snapshot is **load-bearing**: a
   since-heads catch-up *without* the snapshot loses the pre-snapshot-only key. **A
   vault snapshot is safe Plan-B durability only if it carries coverage-heads**, and it
   must store full register metadata — storing only visible values cannot deep-converge
   across the snapshot boundary or resolve post-snapshot overwrites correctly.

3. **Key rotation is clean.** `blocked-by-key` entries buffer and replay losslessly on
   key import (tests 06). A cold client with no keys buffers the entire log and
   converges once both generations' keys arrive. No entry is dropped or mis-decrypted.

4. **Convergence is order-independent.** Test 04 applies the same entry set in two
   permutations to two fresh clients and gets identical state hashes — the transport
   imposes no ordering requirement beyond per-device seq monotonicity, which the
   durable log preserves.

5. **Single-fork execution required for the test harness only.** The spike is
   CPU-bound Ed25519/AES; vitest's default parallel workers oversubscribe the CPU and
   trip per-test timeouts. `fileParallelism: false` + `maxWorkers: 1` fixes it. This
   is a test-harness property, not a design finding.

## Granularity / perf numbers (test 09, granularity.json)

A typical edit session = **50 small map writes** (short key + short coordinate value):

| Metric | Value |
|---|---|
| Log entries produced | **50** (one entry per CRDT update) |
| Entries per edit session | **50** |
| Avg encrypted `data` blob | **141 bytes** (nonce 12 + ciphertext + tag 16) |
| Avg full signed JWS frame | **783 bytes** (Ed25519 sig + JCS JSON payload) |
| Total durable-log bytes | **~39 KB** |

Read: each small edit costs ~0.14 KB of ciphertext but ~0.78 KB on the wire/log once
the JWS envelope (signature + base64 header/payload) is included. The **JWS envelope
dominates** small-update cost (~5.5x the payload). For a heavy editor this is the
argument for **Slice C snapshot batching**: a session of 50 updates (~39 KB of log)
collapses to a single encrypted checkpoint blob plus coverage-heads, and the per-update
JWS overhead is paid once at snapshot time instead of 50 times. Entry-per-update
(Slice A) is correct for the live path and for small/occasional edits; snapshot
batching is the optimization for high-frequency editors and for bounding cold
catch-up size.

## Durability recommendation

**Ship both layers; they are independently relay-independent in different ways.**

| Layer | Relay-independent? | Role |
|---|---|---|
| **Relay durable log** (Slice A + B) | No (lives on the broker) | Primary real-time + catch-up source of truth; fixes cold reconstruction and the loop. Authoritative, append-only, per-`(deviceId,seq)`. |
| **Vault snapshot + coverage-heads** (Slice C) | **Yes** (separate service / can be local export) | Plan-B checkpoint that survives total broker loss. **Not** authoritative alone — must be followed by log catch-up since its heads. Safe only *with* coverage-heads. |

- The **relay log is the everyday durability mechanism** and is what makes a fresh
  client able to rebuild a space. It is the minimum required to unblock the festival
  pivot's "durable persistence" step.
- The **vault snapshot is disaster-recovery durability** independent of the relay. It
  is the right answer to "what if the broker's storage is wiped," but only if every
  snapshot carries coverage-heads so the restore path is
  `merge snapshot -> sync-request log since heads`. A snapshot without heads is, per the
  classifier, only a CRDT merge helper and must not be trusted as state.

Neither replaces the other: relay-log handles routine cold start and catch-up; vault
snapshot handles broker catastrophe and bounds catch-up size. For the festival,
relay-log durability is the must-have; vault snapshots are the safety net.

## Failure mode -> production slice mapping

| Failure mode (historical) | Covered by slice | Evidence in spike |
|---|---|---|
| Permanent space loss on cold reconstruction | **A** (entry-log durable) + **B** (heads catch-up) | 01 HEADLINE green on durable-log; transient control reproduces the loss |
| 5000+ outbox loop | **A**/**B** client write-path loop guard + broker `(deviceId,seq,contentHash)` dedup | 02 loop-free bounded; naive control explodes; broker dedup test (idempotent-retransmission, no re-store/re-broadcast) |
| Offline/cold device cannot resync | **B** (sync-request/response, heads, paging) | 03 catch-up + paging green |
| Concurrent multi-device divergence / nonce reuse | **A** (per-`(deviceId,seq)` seq, deterministic nonce) | 04 per-device seq, distinct nonces, order-independent convergence |
| Restore-from-backup AES-GCM nonce reuse | **R** (restore-clone: seq-collision reject + new-deviceId remedy + device-revoke) | 05a reject without committing reuse; 05b new-deviceId + clean revoke |
| Member added after rotation cannot read history | **D** (key-rotation: blocked-by-key buffer + replay) | 06 buffer->import->replay->converge |
| Broker storage catastrophe | **C** (snapshot + coverage-heads, relay-independent) | 01 PLAN-B snapshot+heads+log converges; heads-less snapshot is merge-only |
| High-frequency editor log bloat | **C** (snapshot batching) | 09 granularity: 50 updates = ~39 KB log, JWS envelope ~5.5x payload |

## Review & hardening (2026-06-23)

The harness was put through a 6-dimension **adversarial review** — each reviewer tasked
to *refute* the GO with executable probes, not to confirm it. Outcome: 4 dimensions
confirmed sound, 2 raised concerns that have since been fixed.

- **CRDT-stub soundness — confirmed.** 24-permutation probe (incl. a Lamport tie) →
  one `stateHash`; merge is commutative/associative/idempotent; `stateHash` is a deep
  content hash over `(value, lamport, deviceId)`, so convergence is real content
  equality, not object identity. The one constructible divergence (two values at the
  same `(lamport, deviceId)`) is unreachable via the public API (monotonic per-device
  Lamport clock).
- **No-cheat reconstruction — confirmed.** A wrong content key makes `catchUp()` throw
  and leaves the doc empty → decryption is genuinely load-bearing; the fresh client
  shares no mutable state with the originals and derives its own Space Content Key.
- **Nonce-reuse / restore-clone — confirmed** (with the wire-exposure note added to
  observation 1): the reject happens before store *and* broadcast, so the durable log
  never holds two ciphertexts under one deterministic nonce.
- **Loop-safety — confirmed.** Loop-freedom is structural; the naive control's growth
  is genuinely unbounded (`appends = 1 + budgetA + budgetB`), not a cap artifact.
- **Snapshot Plan-B — concern, fixed.** The review proved the snapshot previously
  contributed nothing (full-log re-fetch did all the work; coverage-heads skipped zero
  entries) and the classifier output was asserted but never drove behaviour. Fixed:
  snapshots now persist full registers, the restore is driven by the disposition, and
  the test asserts the since-heads optimization (`appliedCount === 2`) plus that the
  snapshot is load-bearing. (See observation 2.)
- **Seam + FINDINGS — concern, fixed.** Seam was already clean (imports only via
  `@web_of_trust/core/protocol[-adapters]`, no reimplemented crypto, `#sig-0` in one
  idiomatic place). Two issues fixed: stray reviewer probe files removed so the wired
  command reports the documented `22/10`; and the broker-dedup guard, previously
  claimed without a shipped test, now has one (test 02 "broker dedup").

## Caveats / things the spike deliberately does not prove

- It uses an in-memory LWW-map stub as the CRDT, not the production CRDT. The Yjs smoke
  (test 08) shows the transport is genuinely opaque-byte-agnostic, but production CRDT
  semantics (tombstones, GC, large-doc encoding) are out of scope here.
- The broker is single-process and synchronous; it models seq/heads/dedup/catch-up
  semantics, not network partitions, broker auth, or real concurrency races. Those are
  covered by separate broker-conformance work.
- The optimistic seq-reservation in the client models "reserve next seq before send."
  Production must persist that reservation durably (or mint a new `deviceId` on
  restore); the spike's rollback-on-reject is a simulation convenience, not a license
  to keep seq state only in memory.
