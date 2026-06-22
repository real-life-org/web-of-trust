# @web_of_trust/sync-spike

Adversarial **sync-reliability spike** that validates the **Sync-002** design (durable
broker log + per-`(deviceId,docId)` seq + deterministic nonce + sync-request/response
+ snapshot-with-coverage-heads) **before** the 1-2 week production migration.

It is a self-contained, in-memory simulation. It does **not** re-implement crypto, JWS
or the sync classifiers — it imports the vector-validated primitives from
`@web_of_trust/core/protocol` and `@web_of_trust/core/protocol-adapters` and drives
them through a simulated broker (`SimRelay`), device (`SimClient`) and vault
(`SimVault`).

## What it validates

A `SimRelay` runs in two switchable modes:

- **`durable-log`** = Sync-002: a retained append-only log per `docId`, keyed by
  `(deviceId,seq)`, with broker-tracked heads and `classifyBrokerSeqCollision`
  enforcement. Serves catch-up given a client's heads.
- **`transient`** = today's bug (mirrors `packages/wot-relay/src/queue.ts`): a
  per-recipient queue `queued -> delivered -> ACK -> ROW DELETED`. After ACK the
  content is gone; there is no retained per-doc log.

The seven core tests are **GREEN under `durable-log`**, and the **transient/naive
controls reproduce the historical failures** (they assert the failure, so the harness
has teeth):

| Test | Validates | Control reproduces |
|---|---|---|
| `01-cold-reconstruction` (HEADLINE) | fresh empty client rebuilds the full space from the durable log; vault snapshot+coverage-heads is a Plan-B checkpoint | transient: space permanently lost after ACK |
| `02-loop-safety` | observe→write does not re-broadcast; duplicate apply is a no-op; bounded broadcasts | naive re-broadcast: 1000+ append explosion (the 5000+ outbox loop) |
| `03-catch-up` | offline/cold client compares heads, sync-requests, pages, converges | — |
| `04-multi-device` | per-`(deviceId,docId)` seq, no nonce reuse, order-independent convergence | — |
| `05-restore-clone` | (a) rewound same-deviceId rejected `SEQ_COLLISION_DETECTED`, no nonce reuse committed; (b) new-deviceId restore + clean device-revoke converges | — |
| `06-key-rotation` | gen-1 entries `blocked-by-key` are buffered, then replayed after key import | — |
| `07-personal-doc` | single-writer multi-device personal doc: catch-up converges, loop-free | — |

Plus `00-smoke` (encrypt→sign→verify→decrypt roundtrip + deterministic-nonce hazard),
`08-yjs-smoke` (optional, skippable: real Yjs binary updates ride the encrypted durable
log to a cold client), and `09-granularity` (entry-count + byte-size measurement →
`granularity.json`, for the Slice A vs Slice C decision).

The CRDT is a deterministic, convergent **LWW-map stub over opaque `Uint8Array`
updates** (`src/crdt-stub.ts`). The harness treats updates as opaque
(encrypt/decrypt/transport never inspect them) so the tests exercise the **sync
design**, not a third-party CRDT. The Yjs smoke confirms the same transport carries a
real CRDT's bytes unchanged.

## Run

```bash
export PATH="/home/fritz/.n/bin:$PATH"   # node is not on the default PATH here
pnpm --filter @web_of_trust/sync-spike test
```

The suite runs serially (it is CPU-bound crypto; see `vitest.config.ts`) and finishes
in a few seconds.

## GO / NO-GO

- **GO** iff all seven core tests are green under `durable-log` **and** the controls
  reproduce the transient/loop failures.
- **NO-GO** if a failure mode is structurally unsolvable by the design; that defect
  would be documented in `FINDINGS.md` rather than faked green.

See [`FINDINGS.md`](./FINDINGS.md) for the verdict, the durability recommendation, the
granularity numbers, and the failure-mode → production-slice mapping.
