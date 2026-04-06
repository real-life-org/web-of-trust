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
# Zeige Änderungen seit letztem Tag
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
2. `packages/wot-fdroid/repo/metadata/org.reallife.weboftrust.yml` — CurrentVersion und CurrentVersionCode

Zeige dem User die neue Version und frage ob sie passt.

### Schritt 4: Web-Assets bauen

**Wichtig:** Der OTA-Channel muss als Env-Variable mitgegeben werden, damit die App weiß wo sie nach Updates suchen soll.

Für F-Droid (FOSS):
```bash
cd "$DEMO_DIR"
VITE_UPDATE_SERVER_URL=https://web-of-trust.de VITE_UPDATE_CHANNEL=android-foss pnpm build:mobile
```

Für Play Store:
```bash
cd "$DEMO_DIR"
VITE_UPDATE_SERVER_URL=https://web-of-trust.de VITE_UPDATE_CHANNEL=android pnpm build:mobile
```

`build:mobile` setzt bereits `VITE_BASE_PATH=/`, baut und synct.

Der Gradle-Flavor (fdroid/playstore) ist **separat** vom OTA-Channel — er bestimmt welche nativen Features drin sind (z.B. Google Push), nicht den Update-Kanal.

### Schritt 5a: Artefakte bauen (bei `apk` oder `full`)

**F-Droid APK:**

```bash
cd "$DEMO_DIR/android"
./gradlew assembleFdroidRelease
```

APK: `app/build/outputs/apk/fdroid/release/app-fdroid-release-unsigned.apk`

**Play Store AAB:**

```bash
cd "$DEMO_DIR/android"
./gradlew bundlePlaystoreRelease
```

AAB: `app/build/outputs/bundle/playstoreRelease/app-playstore-release.aab`

Das AAB wird automatisch mit dem `playstoreRelease` Signing-Key signiert (Gradle Properties).

**F-Droid APK signieren:**

```bash
cd "$FDROID_DIR"
PASS=$(grep keystorepass repo/config.yml | awk '{print $2}')
ALIAS=$(keytool -list -keystore repo/keystore.p12 -storetype PKCS12 -storepass "$PASS" 2>/dev/null | grep PrivateKeyEntry | cut -d, -f1)
VERSION_CODE=$(grep VERSION_CODE "$DEMO_DIR/android/version.properties" | cut -d= -f2)

ANDROID_HOME="${ANDROID_HOME:-$HOME/Android/Sdk}"
BUILD_TOOLS=$(ls -d "$ANDROID_HOME/build-tools"/*/ 2>/dev/null | sort -V | tail -1)
APKSIGNER="${BUILD_TOOLS}apksigner"

$APKSIGNER sign \
  --ks repo/keystore.p12 \
  --ks-key-alias "$ALIAS" \
  --ks-pass "pass:$PASS" \
  --key-pass "pass:$PASS" \
  --out "repo/fdroid/repo/org.reallife.weboftrust_${VERSION_CODE}.apk" \
  "$DEMO_DIR/android/app/build/outputs/apk/fdroid/release/app-fdroid-release-unsigned.apk"
```

**F-Droid Index aktualisieren:**

```bash
cd "$FDROID_DIR/repo"
fdroid update
```

Falls `fdroid` nicht installiert: Sage dem User `pip install fdroidserver` oder `apt install fdroidserver`.

**Play Store Upload:**

```bash
# AAB liegt bereit unter:
echo "$DEMO_DIR/android/app/build/outputs/bundle/playstoreRelease/app-playstore-release.aab"
# Upload manuell über https://play.google.com/console
```

Sage dem User den Pfad zum AAB und dass er es in der Play Console hochladen muss.

### Schritt 5b: OTA-Bundle erstellen (bei `ota` oder `full`)

Das passiert automatisch bei jedem Push auf `main` — kein separater Tag nötig.
Die Pipeline baut die 3 Channel-Bundles, erstellt einen GitHub Release (`ota-<sha>`)
und aktualisiert `web-of-trust.de/updates/<channel>/latest.json`.

### Schritt 6: Commit + Tag + Push

Bei `apk` oder `full`:
```bash
cd "$REPO_ROOT"
VERSION_NAME=$(grep VERSION_NAME "$DEMO_DIR/android/version.properties" | cut -d= -f2)

git add apps/demo/android/version.properties
git add packages/wot-fdroid/repo/metadata/org.reallife.weboftrust.yml
git commit -m "release: v${VERSION_NAME}"
git tag "v${VERSION_NAME}"
```

Frage den User ob gepusht werden soll. Wenn ja:
```bash
git push && git push --tags
```

### Schritt 7: F-Droid Repo deployen (bei `apk` oder `full`)

Frage den User nach dem Server-Zugang:
```bash
rsync -av "$FDROID_DIR/repo/" user@server:/path/to/wot-fdroid/repo/
```

Oder sage dem User welche Dateien manuell auf den Server müssen.

### Schritt 8: Zusammenfassung

Zeige dem User:
- Welcher Modus (ota/apk/full)
- Neue Version (wenn gebumpt)
- Was gebaut wurde (APK-Pfad, OTA-Tag)
- Was deployed wurde
- Nächste Schritte (z.B. "F-Droid Repo auf Server syncen")

## Changelog generieren

Zwischen zwei Tags:
```bash
git log --oneline "$LAST_TAG"..HEAD -- apps/demo/ | sed 's/^[a-f0-9]* /- /'
```
