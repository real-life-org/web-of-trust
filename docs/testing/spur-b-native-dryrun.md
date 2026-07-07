# Spur B — Nativer Geräte-Dry-Run (Operator-Runbook)

Dieses Runbook führt einen Operator mit **zwei echten Android-Geräten** ohne Code-Kenntnis durch
die Spur-B-Szenarien **S1, S8, S9, S11** (optional S12 im Anhang). Es ist das *Werkzeug* für den
Dry-Run, nicht das Urteil — jede Ausführung erzeugt ein dokumentiertes Artefakt
(`docs/testing/spur-b-results-TEMPLATE.md`).

Die App liest ihre Testdaten aus dem gebauten **`staging-debug`**-Build (siehe „Build & Deploy").
Nur dieser Build blendet den **D2-Test-Observability-Screen** ein — die Datenquelle aller
Pass/Fail-Kriterien hier.

---

## ⚠️ Sicherheit (zuerst lesen)

- **Frische Wegwerf-Identitäten verwenden — niemals einen echten Seed.** Das Staging-Backend ist
  Wegwerf-Umgebung.
- **Der Mnemonic-/Seed-Screen wird NIE gescreenshottet oder exportiert.** `screenshot.sh` darf auf
  diesem Screen nicht laufen. Der Seed wird nur handschriftlich/offline notiert.
- Die D2-JSON-Exports enthalten **per Design keine Secrets** (kein Seed, kein Key-Material, keine
  Passphrase — nur Status/Counts/Heads/IDs; dafür existiert in D2 ein Secret-Negativtest). Sie
  dürfen daher an Ergebnis-Zeilen angehängt werden.

---

## Build & Deploy (einmalig pro Test-Session)

Der Dry-Run braucht den `staging-debug`-Build. Er ist ein **production**-Bundle (`import.meta.env.DEV
= false`) mit explizit aktiviertem D2-Flag — nur so erscheint der D2-Screen auf einem echten Gerät.

```bash
# 1. Web-Bundle mit Staging-Backend + D2 bauen (aus dem Repo-Root):
VITE_BASE_PATH=/ pnpm --filter demo exec vite build --mode staging-debug

# 2. Assets in das Android-Projekt syncen (cap-CLI ist devDependency, kein npx nötig):
pnpm --filter demo exec cap sync android

# 3. Debug-APK bauen + auf das Gerät bringen (side-load / manuell — NICHT über OTA):
#    z.B. via android-deploy-Skill oder (aus dem Repo-Root, konsistent mit Schritt 2):
pnpm --filter demo exec cap run android --flavor fdroid
#    (--flavor fdroid wählt den Debug-Flavor ohne interaktiven Prompt; playstore ist die Release-Spur.)
```

Env-Quelle: `apps/demo/.env.staging-debug` (Vite lädt sie wegen `--mode staging-debug` via
`loadEnv(mode, …)` in `vite.config.ts`). Sie setzt `VITE_WOT_DEBUG_OBSERVABILITY=1` plus die
Staging-URLs für Relay/Profiles/Vault.

> **Deploy-Path-Guard (Pflicht-Beleg):** Dieser Build darf **NIE** durch die F-Droid-/OTA-Pipeline
> laufen. Die Release-/OTA-Workflows (`.github/workflows/deploy.yml`) bauen mit `pnpm --filter demo
> build` (= `tsc -b && vite build`) **ohne** `--mode` → Default-Mode `production` → laden
> `.env.production`, **nicht** `.env.staging-debug`. Kein Workflow referenziert `staging-debug`.
> `VITE_WOT_DEBUG_OBSERVABILITY` taucht in keiner prod-Env auf. `staging-debug` ist ausschließlich
> ein manuell side-geloadetes Debug-APK.

## Emulator als Zweitgerät (Voraussetzungen — #239)

Fehlt ein zweites physisches Gerät, funktioniert der Android-Emulator als Gerät B. Drei Fallen aus
dem Dry-Run 2026-07-05, alle VOR dem ersten App-Start abräumen:

1. **WebView zu alt für Ed25519 (Pflicht bei `google_apis`-Images).** android-34 `google_apis`
   kommt mit WebView 113 — zu alt für Ed25519-WebCrypto; Identity-Generate/-Recovery scheitert mit
   „Algorithm: Unrecognized name". Flag setzen (wirkt ab dem nächsten App-Start, **überlebt
   `pm clear`**):

   ```bash
   adb -s emulator-5554 shell "echo '_ --enable-experimental-web-platform-features --enable-features=WebCryptoEd25519' > /data/local/tmp/webview-command-line"
   ```

   Alternative ohne Flag: ein `google_apis_playstore`-Image verwenden und den WebView über den
   Play Store auf ≥ 137 aktualisieren.

2. **OTA-Falle (#238).** Ein zuvor per OTA geladenes Produktions-Bundle überlebt `install -r` und
   überschattet das side-geloadete Test-APK (Capawesome wechselt nur bei geändertem `versionCode`
   aufs Built-in zurück) — man testet dann stillschweigend alten Code. `.env.staging-debug` setzt
   deshalb `VITE_DISABLE_LIVE_UPDATE=true` (Kill-Switch in `live-update.ts`). Verifikation nach
   Install + Start:

   ```bash
   adb -s <device> exec-out run-as org.reallife.weboftrust sh -c 'ls files/_capacitor_live_update_bundles 2>/dev/null || echo OK-kein-OTA-Bundle'
   ```

   Erscheint dort ein Bundle-Verzeichnis → App deinstallieren + neu installieren (nicht nur
   `pm clear`; der Guard verhindert nur NEUE Downloads, wirft ein aktives Bundle nicht raus).

3. **Clipboard-Bridge (#235).** `navigator.clipboard` schlägt im Emulator-WebView fehl — Magic
   Words beim Onboarding **abtippen**, nicht über den Copy-Button verifizieren (auf echten Geräten
   kopiert der native Pfad).

---

## Der D2-Screen: Felder lesen & exportieren

Der D2-Screen ist im `staging-debug`-Build unter dem Debug-Panel erreichbar („Test Observability
(D2)"). Er zeigt einen JSON-Snapshot der **aktuellen Identität**. Über den Button **„Copy JSON"**
(`copyAppSnapshot`) landet `JSON.stringify(snapshot, null, 2)` in der Zwischenablage.

**JSON-Capture verlustfrei ablegen:** Den Export **pro Gerät sofort** in eine Datei schreiben, nach
dem Schema `S<n>-deviceA.json` / `S<n>-deviceB.json` (z.B. `S1-deviceA.json`), und mit `jq . <datei>`
validieren. Parse-Fehler = Capture wiederholen (nicht raten).

Die **exakten Feldnamen** des Exports (autoritativ aus dem gemergten D2-Code,
`apps/demo/src/debug/debugObservability.ts`, `WotDebugSnapshot`):

| Feld | Bedeutung |
|---|---|
| `deviceId` | Store-aufgelöste Geräte-ID (Nonce-Namespace-Identität) |
| `did` | DID der Identität, zu der dieser Snapshot gehört |
| `spaces[].spaceId` | Space-ID |
| `spaces[].name` | Space-Name (`null` möglich) |
| `spaces[].generation` | aktuelle Content-Key-Generation (nie das Key-Material) |
| `spaces[].heads.strictContiguous` | `{ deviceId: seq }` — lückenlos ab Anfang, stoppt an erster Lücke |
| `spaces[].heads.syncRequest` | `{ deviceId: seq }` — Wire-Cursor (springt über Soft-Skip-Marker) |
| `spaces[].heads.known` | `{ deviceId: seq }` — MAX bekannte seq (debug-only) |
| `outboxDepth` | Anzahl noch nicht bestätigter Outbox-Einträge |
| `keystore.enrolled` | `true` \| `false` \| `"error"` (fail-closed) |
| `durableStores[].name` | Name der identitäts-gescopeten IndexedDB-DB |
| `durableStores[].present` | `true` \| `false` \| `"unknown"` (existiert on-disk?) |

### Heads-Semantik (wichtig für die Gap-Kriterien)

- **`known`** = das Maximum der bekannten seq pro Device (debug-only, kann über einer Lücke liegen).
- **`strictContiguous`** = die höchste seq, unter der **keine Lücke** existiert (stoppt an der
  ersten fehlenden seq, springt nie über ein Loch).
- **`syncRequest`** = der effektive Wire-Cursor: wie `strictContiguous`, aber **hinter durablen
  Soft-Skip-Markern weitergerückt**.

**Gap-Freiheits-Kriterium (für S1 & S9):** Ein (doc, device) ist nach Sync-Idle **gap-frei** genau
dann, wenn **`strictContiguous == known`** (der lückenlose Head hat das Maximum eingeholt →
kein Loch). **Nicht `strictContiguous == syncRequest` prüfen** — der Soft-Skip-Cursor kann ein
offenes Loch durchwinken (Gegenbeweis:
`packages/wot-core/tests/LogSyncCoordinatorSliceB.test.ts:400` — remote hat seq 0 und 2 mit Loch bei
1 → `known=2`, `strictContiguous=0`, `syncRequest=0`). `syncRequest == strictContiguous` ist nur
eine Diagnose-Nebenbedingung, kein Pass-Kriterium.

---

## S1 — Durable Persistence über App-Kill

**Frage:** Überleben deviceId + Daten + Log-Heads einen harten App-Kill ohne Restore-Clone?

**Setup:** 1 Gerät, `staging-debug`-Build frisch installiert, keine Alt-Identität.

**Schritte:**
1. Onboarding: neue Identität erstellen (Seed offline notieren, **nicht** screenshotten).
2. Einen Space erstellen, darin **N ≥ 3** Einträge schreiben (z.B. 3 Notizen/Items).
3. D2-Screen öffnen, **„Copy JSON"** → als `S1-deviceA-before.json` ablegen, `jq .` validieren.
   Notiere: `deviceId`, pro Space `heads.strictContiguous` / `heads.known`, `outboxDepth`.
4. Sync abwarten bis idle (`outboxDepth` = 0).
5. Harten Kill auslösen: `scripts/spur-b/force-stop.sh` (kein Wischen aus Recents, echtes
   `am force-stop`).
6. App **cold** neu starten: `scripts/spur-b/force-stop.sh --relaunch` (oder App-Icon).
7. Nach dem Entsperren erneut D2 → `S1-deviceA-after.json`, `jq .` validieren.

**Pass-Kriterien (absolut, keine Parität):**
- ✅ `deviceId` in *before* == *after* (**dieselbe** Geräte-ID — kein Restore-Clone, keine neue ID).
- ✅ Die N Einträge sind nach Relaunch **entschlüsselt sichtbar** (visuell in der App).
- ✅ Pro (doc, device): `heads.strictContiguous == heads.known` nach Idle (**gap-frei**) UND
  beide Werte sind *after* **≥** *before* (monoton, **kein Rücksprung**).
- ✅ Keine `SEQ_COLLISION`-Anzeige/-Fehlermeldung, kein Restore-Clone-Hinweis (Logcat via
  `scripts/spur-b/logcat-filter.sh` gegenprüfen).

**Bei Fail exportieren:** beide JSONs (`before`/`after`) + Screenshot der App-Ansicht (nicht Seed) +
`logcat-filter.sh`-Auszug rund um den Relaunch.

---

## S8 — Teardown / Keystore

**Frage:** Hinterlässt „Identität löschen" einen **geräte-globalen** Keystore-Rest, der ein
Re-Onboarding aussperrt (Soft-Lockout)?

> **D2-Lifecycle — wichtig:** Der D2-App-Snapshot ist an eine **aktive Identität** gebunden (der
> Collector wird beim Identity-Teardown by-design abgemeldet — Teardown = Security-Surface).
> **Direkt nach dem Löschen gibt es keine aktive Identität → der D2-Snapshot ist erwartbar NICHT
> mehr abrufbar** (`window.__wotDebug` weg, kein `wot-debug-json`-Element). Das ist kein Fehler.
> Der `keystore.enrolled`-Nachweis wird daher **nicht** direkt nach dem Delete gelesen, sondern am
> frischen Re-Onboarding (siehe unten).
>
> **Warum das der richtige Nachweis ist:** Der native Keystore-Eintrag (`hasStoredPassphrase`) ist
> **geräte-global**, nicht pro-Identität. Überlebt er das Löschen, findet die frische Identität einen
> **fremden** Eintrag → genau der Soft-Lockout. `keystore.enrolled` auf der frisch onboardeten
> Identität **vor** einem neuen Enroll zeigt also direkt, ob der Delete sauber war.

**Setup:** 1 Gerät mit Identität aus S1 (oder frisch), Biometrie verfügbar.

**Schritte:**
1. Biometrie/Passkey für die (bestehende) Identität **enrollen** (App-Flow „Biometrie aktivieren").
2. D2 → `keystore.enrolled` prüfen: erwartet **`true`**. Als `S8-deviceA-enrolled.json` ablegen.
3. Identität **am Gerät löschen** (App-Flow „Identität löschen / zurücksetzen"). Der D2-Snapshot ist
   danach erwartbar nicht mehr abrufbar — **nicht daran hängenbleiben**, weiter zu Schritt 4.
4. **Frisches Re-Onboarding** (neue Identität) starten — muss **ohne Lockout** anlaufen.
5. **Vor** dem neuen Biometrie-Enroll auf der frischen Identität: D2 → `keystore.enrolled` lesen. Als
   `S8-deviceA-afteronboard.json` ablegen.
6. Danach neuen Biometrie-Enroll auf der frischen Identität durchführen — muss gelingen.

**Pass-Kriterien (absolut):**
- ✅ Nach Enroll (Schritt 2): **`keystore.enrolled === true`**.
- ✅ Auf der frischen Identität **vor** neuem Enroll (Schritt 5): **`keystore.enrolled === false`** —
  der geräte-globale Eintrag hat das Löschen **nicht** überlebt.
- ✅ **`keystore.enrolled === "error"` ist ein FAIL**, nicht pass — fail-closed: ein Fehler beim
  Auslesen zählt als „Rest möglicherweise vorhanden".
- ✅ Das frische Re-Onboarding gelingt **ohne Lockout**; der neue Enroll (Schritt 6) gelingt.

**Bei Fail exportieren:** `enrolled`/`afteronboard`-JSONs + kurze Notiz, ob das Re-Onboarding
blockiert war (Fehlermeldung wörtlich).

---

## S9 — Multi-Device Shared-Seed

**Frage:** Recovern zwei Geräte aus **einem** Seed zu **distinkten** deviceIds, konvergieren die
Heads, und sieht der Server beide Geräte?

### PREFLIGHT (vor jedem Geräte-Schritt — nicht am Gerät debuggen)

Prüfen, dass Staging mit `RELAY_DEBUG_STATS=1` läuft und der Cross-Check überhaupt Daten liefert:

```bash
curl -s https://relay-staging.web-of-trust.de/dashboard/data | jq '.logStats.entriesByDocAndDevice'
```

- Liefert das `null` (oder das Feld fehlt) → Staging läuft **nicht** mit `RELAY_DEBUG_STATS=1`.
  **STOPPEN und den Staging-Deploy fixen** (Relay mit `RELAY_DEBUG_STATS=1` neu starten), **nicht**
  am Gerät weiterdebuggen. `entriesByDocAndDevice`/`devicesByDoc` sind nur bei aktivem Debug-Flag im
  `/dashboard/data`-Payload.

**Setup:** 2 Geräte (A, B), beide `staging-debug`-Build, gegen dasselbe Staging-Relay.

**Schritte:**
1. Gerät **A**: neue Identität + Space + einige Einträge. Seed offline notieren (nicht screenshotten).
2. Gerät **B**: **Recovery per Mnemonic** mit demselben Seed.
3. Auf beiden Geräten: einige Einträge schreiben, Sync idle abwarten (`outboxDepth` = 0 beidseitig).
4. D2 auf **beiden** Geräten → `S9-deviceA.json` / `S9-deviceB.json`, jeweils `jq .` validieren.
5. Server-Cross-Check ausführen (siehe unten).

**Pass-Kriterien (absolut):**
- ✅ **Distinkte deviceIds:** `deviceId` in `S9-deviceA.json` ≠ `deviceId` in `S9-deviceB.json`
  (ein geteilter Seed heißt **nicht** geteilte Geräte-ID).
- ✅ **Heads konvergieren:** für den gemeinsamen Space ist pro (doc, device) nach Idle
  `heads.strictContiguous == heads.known` (gap-frei) **auf beiden Geräten**, und beide Geräte kennen
  beide deviceIds mit demselben contiguous-Head.
- ✅ **Server sieht beide Geräte** (Cross-Check):

```bash
curl -s https://relay-staging.web-of-trust.de/dashboard/data | jq '.logStats'
```

  Mit `docId` = die Space-/Doc-ID aus dem D2-Export:
  - `logStats.devicesByDoc[docId] === 2` — **ein COUNT (number)**, keine Liste
    (`packages/wot-relay/src/log-store.ts:845`).
  - `logStats.entriesByDocAndDevice[docId]` enthält **beide deviceIds als Keys**, jeweils mit Wert
    **> 0** (`log-store.ts:860`, Wert = Eintrags-COUNT pro Device).

**Bei Fail exportieren:** beide D2-JSONs + der `jq '.logStats'`-Ausschnitt für den betroffenen
`docId`.

---

## S11 — Android-Lifecycle

**Frage:** Übersteht der State background/foreground-Zyklen und OS-Suspend, ohne Reconnect-Sturm
oder Outbox-Schleife?

**Setup:** 1 Gerät mit Identität + Space + laufendem Sync.

**Schritte:**
1. D2 → `S11-deviceA-before.json` (`deviceId`, Heads, `outboxDepth`).
2. **background/foreground-Zyklen** (5×): Home-Taste → ~10 s warten → App zurückholen.
3. **OS-Suspend** provozieren: Bildschirm aus, ~1–2 min, wieder an; App zurückholen. (Optional
   Doze/Standby erzwingen, falls verfügbar.)
4. **Abgrenzung force-stop:** danach einmal `scripts/spur-b/force-stop.sh --relaunch`, um Suspend
   (State hält) von hartem Kill (Cold-Restore, siehe S1) zu unterscheiden.
5. Nach jedem Zurückholen kurz `scripts/spur-b/logcat-filter.sh` beobachten.
6. D2 → `S11-deviceA-after.json`.

**Pass-Kriterien (absolut):**
- ✅ `deviceId` unverändert (before == after).
- ✅ Heads (`strictContiguous`/`known`) unverändert bzw. nur **monoton vorwärts** — kein Rücksprung.
- ✅ **Reconnect greift:** nach foreground ist die Verbindung wieder aktiv (Sync läuft, neue Writes
  propagieren).
- ✅ **Keine Outbox-Schleife:** `outboxDepth` kehrt nach Sync-Idle auf **0** zurück und bleibt dort
  (kein stetiges Anwachsen; im Logcat kein Reconnect-/Send-Sturm).

**Bei Fail exportieren:** before/after-JSONs + `logcat-filter.sh`-Auszug (der den Sturm/Loop zeigt).

---

## Anhang S12 (optional, timeboxed) — Keepalive-Idle

Nur wenn Zeit bleibt: App über das WS-Keepalive-Timeout hinweg **idle** lassen (Bildschirm an, keine
Interaktion, > Keepalive-Intervall), dann eine Aktion auslösen.

- ✅ Sauberer Reconnect (kein hängender Socket), Writes nach Idle propagieren.
- ✅ `outboxDepth` geht nach dem Reconnect auf 0.

---

## Anhang: iOS

iOS-Deploy ist **nicht** Teil dieses Dry-Runs (Android first). Das iOS-Build-/Deploy-Rezept
(Capacitor) steht in `apps/demo/CLAUDE.md` („iOS Deployment"). Für einen iOS-Dry-Run gilt dieselbe
`--mode staging-debug`-Logik; die adb-Helfer sind dann durch die entsprechenden iOS-Werkzeuge zu
ersetzen.

---

## Helfer-Skripte (`scripts/spur-b/`)

| Skript | Zweck |
|---|---|
| `force-stop.sh [--relaunch]` | harter App-Kill (S1/S11), optional Cold-Relaunch |
| `screenshot.sh [datei.png]` | Screenshot vom Gerät ziehen (**nie** der Seed-Screen) |
| `logcat-filter.sh` | Logcat auf den App-Prozess gefiltert (Reconnect-Sturm / SEQ_COLLISION) |

Env-Overrides: `WOT_PKG` (App-ID, Default `org.reallife.weboftrust`), `WOT_ACTIVITY`,
`ANDROID_SERIAL` (Gerät bei mehreren angeschlossenen).
