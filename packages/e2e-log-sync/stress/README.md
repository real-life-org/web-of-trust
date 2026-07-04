# Festival-Scale-Stress Runner

Protocol-level load test: does the relay + protocol carry festival scale
(~100 users / 120 devices / 10 spaces) through write bursts, offline catch-up storms,
and member-removal rotations under load — with **zero data loss** and **zero
unexpected errors**?

This is a **standalone `tsx` runner**, not a vitest suite (20–30-min runs don't fit
vitest's timeouts/isolation). It reuses the e2e-log-sync harness building blocks
(`makeIdentity`, `makeYjsClient`, `RawRelayClient`, `waitFor`).

> **What it is NOT:** real devices / radio / Doze / NAT (that is Spur B). 120 in-process
> Node clients measure the relay + protocol, not handset behavior. The runner detects
> client-side saturation (event-loop lag) and flags latencies as client-limited when it
> trips.

## Run

```bash
# Mode L (local, full scale) — spawns a real relay subprocess with file-backed SQLite:
pnpm --filter @web_of_trust/e2e-log-sync stress

# Smoke variant (fast, for a sanity check / PR artifact):
USERS=10 SPACES=2 DUAL_DEVICE_USERS=2 BURST_MSGS_PER_DEVICE=5 \
  pnpm --filter @web_of_trust/e2e-log-sync stress
```

Artifacts (relay db, relay log, JSON + Markdown report) land under
`stress-artifacts/<timestamp>/` (gitignored).

### Mode S (remote staging — DESTRUCTIVE, coordinate first)

```bash
REMOTE_RELAY_URL=wss://relay-staging.web-of-trust.de \
REMOTE_ALLOW_DESTRUCTIVE=1 \
  pnpm --filter @web_of_trust/e2e-log-sync stress
```

⚠️ Mode S runs against the **shared** staging relay and performs rotations (destructive).
It requires `REMOTE_ALLOW_DESTRUCTIVE=1`, uses throwaway identities, and defaults to
reduced scale (≈18 users / 3 spaces). **Coordinate with Anton** — Spur-B dry-runs also
use staging. Staging must run with `RELAY_DEBUG_STATS=1` (the audit + observation read
`/dashboard/data`); the runner fails loud if the debug stats fields are absent.

### PROD-GUARD

The runner refuses any production relay host (`relay.web-of-trust.de`,
`relay.utopia-lab.org`) across ws/wss/http/https and is **fail-closed** (only
localhost / 127.0.0.1 / ::1 / relay-staging are allowlisted). There is **no override**.
Covered by `tests/stress-prod-guard.test.ts`.

## Parameters (env, with defaults)

| Env | Default (Mode L) | Meaning |
|---|---|---|
| `USERS` | 100 | number of identities |
| `DUAL_DEVICE_USERS` | 20 | users with a 2nd device (→ 120 devices) |
| `SPACES` | 10 | number of spaces (space 0 = big festival group) |
| `BIG_SPACE_MEMBERS` | 30 | members of the big group (rest 8–12) |
| `BURST_MSGS_PER_DEVICE` | 20 | writes/device in the burst phase |
| `OFFLINE_COHORT_PCT` | 30 | % of devices that disconnect for the catch-up storm |
| `SEED` | 42 | deterministic RNG seed (reproducible run shape) |
| `STRESS_RELAY_PORT` | 18787 | Mode L relay port (fail-fast if busy) |
| `DB_PATH` | `stress-artifacts/<ts>/relay.db` | Mode L SQLite file |
| `STRESS_ARTIFACTS_DIR` | `stress-artifacts/<ts>` | report/artifact dir |
| `REMOTE_RELAY_URL` | — | set → Mode S (staging) |
| `REMOTE_ALLOW_DESTRUCTIVE` | — | required truthy for Mode S |

## What it proves

**Hard gates** (exit 0 only if all pass):

- **Process survived** — the relay + runner did not crash.
- **Zero-loss** — every expected logical `writeId` is present in the wire-reconstructed
  CRDT. Proven by pulling every log-entry JWS (paginated, cursor from decoded entries),
  verify → decrypt (historical space keys per generation) → apply to a scratch `Y.Doc`,
  then checking `_stressWrites` completeness. **Not** relay seqs: VE-C2 re-emits stale
  writes under a new seq, so seq gaps are legitimate and only **classified/reported**.
- **Zero unexpected errors** — relay error-frame tally per client; expected rejects
  (`KEY_GENERATION_STALE`, `CAPABILITY_GENERATION_STALE`, `DEVICE_REVOKED`,
  `CAPABILITY_EXPIRED`) are classified; anything else fails the gate.
- **Removed member reads nothing** — a removed member cannot decrypt a post-rotation
  canary.
- **Remaining members write after rotation** — every remaining device writes on the new
  generation (no hung blocked-by-key).

**Baseline** (reported, not gated — Anton makes the go/no-go call): burst latency
p50/p95/p99, offline catch-up convergence time, relay RSS + SQLite size, reconnect
count, client event-loop lag.

## Interpreting the report

`stress-report-<ts>.json` (machine-readable, fixed field names) + `stress-report-<ts>.md`
(summary). Check `gates.passed` first. If a gate fails, drill into `audit[].missingWriteIds`
(loss), `errors.unexpectedByCode` (errors), or the `notes[]` (leaks, stalls, saturation).
If `baseline.clientSaturationSuspected` is true, the latency numbers reflect the in-process
client harness, not the relay — re-run at lower scale or sharded (follow-up).

## Surfaced observations (candidate findings, not fixed inline)

Per the directive, the runner **reports** protocol observations rather than fixing them inline
(a real relay/protocol issue → separate fix slice).

- **Multi-device (same-DID, two-device) write convergence.** With `DUAL_DEVICE_USERS > 0` at 10
  users, ~1–10 writes/space (authored by BOTH second AND primary devices) did not converge within
  budget, run-to-run variable, **NOT** correlated with client saturation (event-loop lag < 65 ms).
  The single-device + offline-catch-up + rotation paths are clean (zero-loss / zero-error). This may
  be a real multi-device same-DID convergence gap (cf. the seq/nonce coupling debt) OR a
  dual-device-modeling artifact in this runner; it needs a dedicated investigation slice. The
  committed smoke artifact therefore uses `DUAL_DEVICE_USERS=0`; dual-device is available via env for
  the follow-up.

## Gotchas

- `better-sqlite3` native bindings (the relay's SQLite): if a run fails to boot the relay
  with a bindings error, rebuild via `prebuild-install --runtime node` (known sandbox
  gotcha) in `packages/wot-relay`.
- The relay fail-fasts on a busy port (no retry) — the runner surfaces that as a clear
  "port in use" error pointing at `stress-artifacts/<ts>/relay.log`.
