# Spur-B Dry-Run — Ergebnis-Protokoll

> Kopie dieses Templates pro Dry-Run-Session anlegen (z.B.
> `spur-b-results-2026-07-DD.md`). Jede Zeile ist ein dokumentiertes Artefakt für die
> Festival-Readiness. Runbook: [`spur-b-native-dryrun.md`](./spur-b-native-dryrun.md).

## Session-Kopf

| Feld | Wert |
|---|---|
| Datum | YYYY-MM-DD |
| Operator | |
| Gerät A | Hersteller / Modell / Android-Version |
| Gerät B | Hersteller / Modell / Android-Version |
| Build-SHA | `git rev-parse --short HEAD` des `staging-debug`-Builds |
| Build-Mode | `staging-debug` |
| Relay | `wss://relay-staging.web-of-trust.de` |
| `RELAY_DEBUG_STATS` | ✅ / ❌ (S9-Preflight-Ergebnis) |

## Ergebnisse

| Szenario | Geräte | Pass/Fail | D2-JSON-Anhänge | Notizen |
|---|---|---|---|---|
| S1 — Durable Persistence über App-Kill | A | ⬜ Pass / ⬜ Fail | `S1-deviceA-before.json`, `S1-deviceA-after.json` | deviceId gleich? Heads gap-frei + monoton? SEQ_COLLISION? |
| S8 — Teardown / Keystore | A | ⬜ Pass / ⬜ Fail | `S8-deviceA-enrolled.json`, `S8-deviceA-afterdelete.json` | `keystore.enrolled` nach Delete = `false`? (`"error"` = Fail) Re-Onboarding ohne Lockout? |
| S9 — Multi-Device Shared-Seed | A + B | ⬜ Pass / ⬜ Fail | `S9-deviceA.json`, `S9-deviceB.json`, `logStats`-Ausschnitt | distinkte deviceIds? Heads konvergent? `devicesByDoc[docId]===2` + beide deviceIds als Keys? |
| S11 — Android-Lifecycle | A | ⬜ Pass / ⬜ Fail | `S11-deviceA-before.json`, `S11-deviceA-after.json`, Logcat-Auszug | deviceId/Heads stabil? Reconnect greift? `outboxDepth` zurück auf 0 (keine Schleife)? |
| S12 — Keepalive-Idle (optional) | A | ⬜ Pass / ⬜ Fail / ⬜ n/a | ggf. JSON + Logcat | sauberer Reconnect nach Idle? |

## Gefundene Lücken / Auffälligkeiten

- (Fehlt ein Observable, das das Runbook braucht? → als Lücke an Opus/Anton melden, **nicht** am
  Gerät nachbauen.)
- (Server-Preflight fehlgeschlagen? → Staging-Deploy-TODO notieren.)

## Anhänge

- Alle `S<n>-device<X>*.json`-Exporte (mit `jq .` validiert).
- Screenshots (**nie** der Seed-Screen).
- Relevante `logcat-filter.sh`-Auszüge.
