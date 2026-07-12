---
description: Erstellt ein neues Release der WoT App — Version bumpen, APK bauen, F-Droid Repo aktualisieren, OTA-Bundle erstellen. Nutze diesen Skill wenn ein neues Release veröffentlicht werden soll.
allowed-tools: [Bash, Read, Edit, Write, Glob, Grep]
---

# Android Release

Erstellt ein neues Release der WoT Demo App. Unterstützt drei Modi:

- **`ota`** — Nur Web-Änderungen, OTA-Bundle über GitHub Pages (kein APK nötig)
- **`apk`** — Neues APK mit Version-Bump, signiert, ins F-Droid Repo
- **`full`** — Beides: APK + OTA

## Umgebung

```bash
REPO_ROOT=$(git rev-parse --show-toplevel)
DEMO_DIR="$REPO_ROOT/apps/demo"
FDROID_DIR="$REPO_ROOT/packages/wot-fdroid"
export PATH="$HOME/Android/Sdk/build-tools/36.0.0:$PATH"
```

## Ablauf

### Schritt 1: Modus bestimmen

Interpretiere $ARGUMENTS:

- `ota`, `web`, `hotfix` → Modus `ota`
- `apk`, `native`, `fdroid` → Modus `apk`
- `full`, `release`, ohne Argument → Modus `full`
- Optional: Versionsnummer z.B. `0.2.0` → nutze diese, sonst auto-increment

### Schritt 2: Prüfe was sich geändert hat

```bash
cd "$REPO_ROOT"
LAST_TAG=$(git describe --tags --abbrev=0 2>/dev/null || echo "")
if [ -n "$LAST_TAG" ]; then
  git log --oneline "$LAST_TAG"..HEAD -- apps/demo/
fi
```

Prüfe ob native Änderungen dabei sind:

```bash
git diff --name-only "$LAST_TAG"..HEAD -- \
  apps/demo/android/ \
  apps/demo/ios/ \
  apps/demo/capacitor.config.ts
```

Wenn native Änderungen vorhanden aber Modus `ota` gewählt:
- **Warne den User:** "Es gibt native Änderungen die per OTA nicht deployed werden. Sicher dass du nur OTA willst?"

### Schritt 3: Version bumpen (nur bei `apk` oder `full`)

Lies aktuelle Version:

```bash
cat "$DEMO_DIR/android/version.properties"
```

Bump-Logik (wenn keine Version angegeben):
- Patch-Bump: `0.1.0` → `0.1.1`, VERSION_CODE +1

Aktualisiere:

1. `apps/demo/android/version.properties` — VERSION_CODE und VERSION_NAME
2. `packages/wot-fdroid/fdroid/metadata/org.reallife.weboftrust.yml` — CurrentVersion und CurrentVersionCode

Zeige dem User die neue Version und frage ob sie passt.

### Schritt 4: Web-Assets bauen

**Wichtig:** Backend-URLs UND OTA-Channel explizit als Env-Variablen mitgeben — nicht auf die `.env`-Defaults verlassen (Belt-and-Suspenders: falls die `.env` je driftet, backt dieser Befehl trotzdem den richtigen Produktions-Server). Ein falsch gebackenes Relay wandert sonst still in ein signiertes Release.

```bash
cd "$DEMO_DIR"
VITE_RELAY_URL=wss://relay.web-of-trust.de \
VITE_PROFILE_SERVICE_URL=https://profiles.web-of-trust.de \
VITE_VAULT_URL=https://vault.web-of-trust.de \
VITE_UPDATE_SERVER_URL=https://web-of-trust.de \
VITE_UPDATE_CHANNEL=android-foss \
pnpm build:mobile
```

`build:mobile` setzt bereits `VITE_BASE_PATH=/`, baut und synct.

**Verifizieren (bevor signiert wird):** das gebaute Bundle darf NUR die Server-URLs enthalten:
```bash
d="$DEMO_DIR/dist/assets"
grep -rl "utopia-lab" $d/*.js | wc -l    # MUSS 0 sein (alte, tote Relay)
grep -rl "relay.box"  $d/*.js | wc -l    # MUSS 0 sein (Festival-Box)
grep -rlE "wss://relay\.web-of-trust\.de" $d/*.js | wc -l  # MUSS >=1 sein
```

### Schritt 5a: F-Droid APK bauen (bei `apk` oder `full`)

Der fdroid Flavor hat kein signingConfig — Gradle baut ein unsigned APK.
Danach manuell mit dem F-Droid Keystore signieren.

```bash
cd "$DEMO_DIR/android"
./gradlew assembleFdroidRelease
```

APK signieren und ins F-Droid Repo kopieren:

```bash
cd "$FDROID_DIR/fdroid"
KEYSTORE="$HOME/.android/fdroid-keystore.p12"
PASS=$(grep keystorepass config.yml | awk '{print $2}')
ALIAS=$(keytool -list -keystore "$KEYSTORE" -storetype PKCS12 -storepass "$PASS" 2>/dev/null | grep PrivateKeyEntry | cut -d, -f1)
VERSION_CODE=$(grep VERSION_CODE "$DEMO_DIR/android/version.properties" | cut -d= -f2)

export PATH="$HOME/Android/Sdk/build-tools/36.0.0:$PATH"
apksigner sign \
  --ks "$KEYSTORE" \
  --ks-key-alias "$ALIAS" \
  --ks-pass "pass:$PASS" \
  --key-pass "pass:$PASS" \
  --out "repo/org.reallife.weboftrust_${VERSION_CODE}.apk" \
  "$DEMO_DIR/android/app/build/outputs/apk/fdroid/release/app-fdroid-release-unsigned.apk"
```

F-Droid Index aktualisieren:

```bash
fdroid update
```

Falls `fdroid` nicht installiert: `pip install fdroidserver`

### Schritt 5b: Play Store AAB bauen (optional)

```bash
cd "$DEMO_DIR/android"
./gradlew bundlePlaystoreRelease
```

AAB: `app/build/outputs/bundle/playstoreRelease/app-playstore-release.aab`

Sage dem User den Pfad — Upload manuell über https://play.google.com/console

### Schritt 5c: OTA-Bundle (bei `ota` oder `full`)

Passiert automatisch bei Push auf `main` — GitHub Actions baut die 3 Channel-Bundles.

### Schritt 6: Commit + Tag + Push

```bash
cd "$REPO_ROOT"
VERSION_NAME=$(grep VERSION_NAME "$DEMO_DIR/android/version.properties" | cut -d= -f2)

git add apps/demo/android/version.properties
git commit -m "release: v${VERSION_NAME}"
git tag "v${VERSION_NAME}"
```

Frage den User ob gepusht werden soll. Wenn ja:

```bash
git push && git push --tags
```

### Schritt 7: F-Droid Repo deployen

Sage dem User: "Lade den Ordner `packages/wot-fdroid/fdroid/` per FileZilla auf den Server hoch."

Alternativ:

```bash
rsync -av "$FDROID_DIR/fdroid/" user@server:/path/to/wot-fdroid/fdroid/
```

### Schritt 8: Zusammenfassung

Zeige dem User:

- Welcher Modus (ota/apk/full)
- Neue Version (wenn gebumpt)
- Was gebaut wurde (APK-Pfad, OTA-Tag)
- Nächste Schritte (F-Droid Repo hochladen, Play Console)

## Changelog generieren

```bash
git log --oneline "$LAST_TAG"..HEAD -- apps/demo/ | sed 's/^[a-f0-9]* /- /'
```
