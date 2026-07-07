# Spur-B Dry-Run — Ergebnis-Protokoll (2026-07-05)

> **Status-Nachtrag (2026-07-06): ALLE 6 Findings gefixt und runtime-verifiziert.**
>
> | Fund | Issue | Fix | Verifikation |
> |---|---|---|---|
> | 1 — OTA überschreibt Test-Builds | #238 | PR #244 (Kill-Switch `VITE_DISABLE_LIVE_UPDATE`; der unten in Fund 1 beschriebene `VITE_UPDATE_CHANNEL`-Workaround war wirkungslos — Server liefert für unbekannte Channels HTML/200 statt 404 — und ist ÜBERHOLT) | am Gerät: kein OTA-Bundle-Dir nach fresh install |
> | 2 — outboxDepth klemmt | #236 | PR #245 (eine Retry-Autorität für Log-Sync-Envelopes) | Box-Dry-Run 06.07.: `outboxDepth 0` beidseitig, auch nach Kill+Relaunch |
> | 3 — Panel „Relay Disconnected" | #237 | PR #247 (globalThis-Singleton gegen Chunk-Duplikation) | Test simuliert Duplikation; Panel-Status im 06.07.-Lauf korrekt |
> | 4 — Seed-Copy-Crash | #235 | PR #243 (`@capacitor/clipboard` nativ + sichtbarer Fallback) | Emulator (WebView 113): „Kopiert!" via nativem Plugin, kein Crash |
> | 5 — Emulator-WebView zu alt | #239 | PR #246 (Runbook-Abschnitt „Emulator als Zweitgerät") | — (Docs) |
> | 6 — Recovery-Device kann nicht schreiben | #234 | PR #242 (grow-only `capabilitySigningSeeds` im PersonalDoc + Backfill) | Staging-Emulator-Kette 06.07. **und** Box-Dry-Run S9: Recovery-Write kommt durch |
>
> Zweiter Dry-Run (S1+S9) am 2026-07-06 **gegen die Festival-Offline-Box** (Pi): PASS auf allen Kriterien; E2E-Suite 18/18 gegen die Box (PR #248).

Runbook: [`../spur-b-native-dryrun.md`](../spur-b-native-dryrun.md). Live durchgeführt (Anton am Gerät, Claude Werkzeug/adb/Auswertung).

## Session-Kopf

| Feld | Wert |
|---|---|
| Datum | 2026-07-05 |
| Operator | Anton (+ Claude adb/Auswertung) |
| Gerät A | Google Pixel 8 Pro (husky), `3B210DLJG000NX` |
| Gerät B | — (S9 folgt) |
| Build-SHA | `a108ae62` (spec-vnext) + staging-debug-Bundle |
| Build-Mode | `staging-debug` (fdroid-debug-APK, side-loaded) |
| Relay | `wss://relay-staging.web-of-trust.de` (logcat + Banner + Server-connectedDids bestätigt) |
| `RELAY_DEBUG_STATS` | ✅ (S9-Preflight: `logStats.entriesByDocAndDevice` vorhanden) |

## Ergebnisse

| Szenario | Geräte | Pass/Fail | Notizen |
|---|---|---|---|
| **S1 — Durable Persistence über App-Kill** | A | ✅ **PASS** | deviceId stabil (`121e37ef-ce81-41c0-ae88-584d6ed613fe` vor+nach); Load-Source nach Relaunch `compact-store` 12.6 KB / 9 ms (nicht `new`); Nachrichten 123/456/789 erhalten; Heads gen 0 identisch, kein Rücksprung; Server-Cross-Check 4+4 Entries unverändert (kein Restore-Clone); kein SEQ_COLLISION/AUTHOR_MISMATCH/DEVICE_NOT_REGISTERED im logcat; Keystore enrolled true. |
| **S8 — Teardown / Keystore** | A | ✅ **PASS** | Identität gelöscht → sauberer Redirect auf Onboarding (kein Lockout/Hänger, W5-Wipe-Gate greift). Frisches Re-Onboarding (neue deviceId `c8e90af8-f404-4371-aa89-905761515c6b`, Load-Source `new`/0 B): **`keystore.enrolled === false`** VOR neuem Enroll → der geräteweite Keystore-Eintrag der gelöschten Identität ist wirklich geräumt, KEIN Soft-Lockout, kein fail-closed `"error"`. |
| **S9 — Multi-Device Shared-Seed** | A (Handy) + B (Emulator) | ⚠️ **TEILWEISE / ECHTER BUG** | Recovery + Read-Sync ✅, aber Recovery-Device kann nicht in bestehende Spaces schreiben (siehe Fund 6). deviceIds distinkt (A `c8e90af8…`, B `18402963…`); B via **Vault** recovered; **A→B Content-Sync** live (alle A-Nachrichten auf B); **A2-PersonalDoc-Log-Sync** beidseitig (Relay-doc `36f0560a` mit BEIDEN deviceIds als Autoren). |
| S11 — Android-Lifecycle | A | ⬜ offen | — |

## Gefundene Lücken / Auffälligkeiten

1. **OTA-Live-Updater überschreibt Test-Builds (WERKZEUG-BUG, gefixt im Dry-Run):** Beim ersten Start zog `live-update.ts` das Produktions-Bundle vom `android`-Kanal (`web-of-trust.de/updates/android/latest.json`, gebaut von `main` = **Legacy**) und ersetzte den staging-debug-Build (`_capacitor_live_update_bundles/` auf dem Gerät). Symptom: die getestete App war die alte Demo ohne vNext/D2. **Fix:** `VITE_UPDATE_CHANNEL=disabled` in `.env.staging-debug` → nicht-existenter Kanal → 404 → sauberer No-op (`live-update.ts:25`). Nach `pm clear` + Reinstall: kein Live-Update-Bundle mehr gezogen, vNext bestätigt. → **gehört als Runbook-/env-Fix in einen kleinen PR.**
2. **Outbox-depth klemmt bei 1 (Beobachtungspunkt, KEIN Datenverlust):** Nach Relaunch bleibt `outboxDepth = 1` auch 45 s später, obwohl der Server ALLE Entries hat (4/4) und `connectedDids:1`. Verdacht: gekoppelt an den Anzeige-Widerspruch (#3). Kandidat für Cleanup-Hygiene-Klasse (vgl. #194). Log-Sync liefert korrekt; ein Outbox-Eintrag wird nicht gecleart.
3. **Anzeige-NIT:** D2-Panel-Zeile "SYNC: Relay Disconnected" widerspricht dem grünen Banner "Relay verbunden" + Server-`connectedDids:1`. Der Persistence-Snapshot-Sync-Status (Legacy-Kanal) ≠ der echte vNext-Log-Sync-Kanal. Rein kosmetisch, aber verwirrend für einen Operator.

## Anhänge

- Screenshots unter dem Session-Scratchpad (S1 Baseline / pre-kill / relaunch / after). Kein Seed-Screen erfasst.

4. **🔴 Seed-„Kopieren"-Button wirft Unhandled Promise Rejection (ECHTER APP-BUG, Seed-Verlust-Risiko):** Auf dem Magische-Wörter-Screen (Onboarding) löst der Copy-to-Clipboard-Button aus: `NotAllowedError: Write permission denied` — **`Uncaught (in promise)`** (logcat `Capacitor/Console`, WebView-Origin `https://localhost`). Ursache: App nutzt die **Web-Clipboard-API** (`navigator.clipboard.writeText`) statt `@capacitor/clipboard`; die WebView-Permission-Policy verweigert `clipboard-write`. **Zwei Ebenen:** (a) Copy funktioniert im WebView nicht, (b) der Fehler ist ungefangen → kein Fallback/Toast. **Risiko:** User vertraut dem „Kopiert", notiert nicht manuell, Clipboard leer → Seed-/Identitätsverlust. WebView-versionsabhängig (Emulator-WebView 113; auf neuerem WebView evtl. unauffällig → entgeht leicht dem Test). **Fix:** `@capacitor/clipboard`-Plugin + try/catch mit sichtbarem Fallback. → **Fix-Slice-Kandidat.**
5. **Emulator-WebView zu alt für Ed25519 (Werkzeug-Hinweis, nicht Produkt):** Der google_apis-Emulator (android-34) kommt mit **WebView 113** — zu alt für Ed25519-WebCrypto (wie Chrome 133 in der E2E). Identity-Generate/Recovery scheitert dort mit "Algorithm: Unrecognized name". Workaround für den Dry-Run: WebView-Flag `--enable-experimental-web-platform-features --enable-features=WebCryptoEd25519` via `/data/local/tmp/webview-command-line` → Ed25519 verfügbar (verifiziert: Generate lief durch). Gehört in das Runbook als Emulator-Voraussetzung.

6. **🔴🔴 FESTIVAL-KRITISCH — Recovery-Device kann nicht in bestehende Spaces schreiben (fehlendes Capability-Signing-Seed @ gen=0):** Ein per Shared-Seed **recovertes** Zweitgerät (B) LIEST einen vor der Recovery angelegten Space fehlerfrei (Content-Key kam via PersonalDoc/Vault → alle Nachrichten von A sichtbar), aber jeder **Schreibversuch** scheitert: `[YjsReplication] log write failed (will retry on reconnect): Error: No capability signing seed for space 6271f046… @ gen 0`. Der Space-Content-doc am Relay bleibt single-author (nur A), Bs Nachricht landet nie. D2 auf B: **Outbox depth = 2** (die blockierten Writes hängen fest — koppelt zum S1-Outbox-Beobachtungspunkt), Space-Heads (strict/sync/known) enthalten **nur A's deviceId** (Bs Writes nie im Log). B HAT den Content-Key (`wot-key-management: true` nach Space-Zugriff, LIEST), aber nicht das Capability-**Signing**-Seed für gen=0. **Klasse:** dasselbe „lesen ja / schreiben nein" wie der I-CAP-Fall (#227) — dort für **Rotation gen≥1** (Seed reist in der key-rotation-Message) gelöst; hier für **Recovery bei gen=0**, wo das initiale Capability-Signing-Material **nicht im Vault-Snapshot/PersonalDoc mit-synced** wird. **Festival-Szenario:** User richtet zweites Gerät (gleicher Seed) ein → kann in eigene bestehende Spaces nur lesen, nicht schreiben. **Beantwortet die offene Frage der Stress-Investigation (#232) auf echter getrennter-Store-Multi-Device-Konfiguration: es IST ein echter Produkt-Bug (kein Harness-Artefakt), aber ein ANDERER als der Stress-Silent-Loss (dort war es das geteilte Store-Modell).** → **eigener Fix-Slice + GitHub-Issue; Invarianten-Modell: „Recovery-/Zweitgerät MUSS das Capability-Signing-Material für bestehende Spaces (gen 0..current) erhalten" — analog I-CAP, aber über den Vault/PersonalDoc-Recovery-Pfad statt der key-rotation-Message.**

## Angelegte Issues
| Fund | Issue | Prio |
|---|---|---|
| 6 — Recovery-Device kann bestehende Spaces nicht beschreiben | #234 | P1 (festival) |
| 5 — Seed-Copy Unhandled Rejection | #235 | P1 |
| 4 — Outbox-Tiefe nicht geräumt | #236 | P2 |
| 3 — Panel Relay-Disconnected-Anzeige | #237 | P3 |
| 1 — OTA überschreibt Test-Builds | #238 | P2 |
| 2 — Emulator-WebView zu alt (Ed25519) | #239 | P3 (docs) |
