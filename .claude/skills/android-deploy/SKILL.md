---
description: Baut ein neues APK der WoT Demo App mit nativen Änderungen und deployt es auf ein verbundenes Android-Gerät. Nur nötig bei nativen Änderungen (Java/Swift Plugins, Gradle, Permissions, Capacitor Plugins). Für reine Web-Änderungen (TS, CSS, React) reicht ein Push auf main — das OTA-System deployed automatisch.
allowed-tools: [Bash, Read, Glob]
---

# Android Native Deploy

Baut ein neues APK und deployt es auf ein Android-Gerät.

**Wann braucht man das?** Nur bei nativen Änderungen:
- Java/Swift Plugins (z.B. BiometricKeystorePlugin)
- Gradle Config (Flavors, Dependencies, Signing)
- AndroidManifest.xml (Permissions)
- Capacitor Plugins (neue installiert/entfernt)
- capacitor.config.ts

**Für Web-Änderungen** (TypeScript, React, CSS, i18n) reicht ein `git push` auf `main` — die GitHub Actions Pipeline baut automatisch ein OTA-Bundle das die App beim nächsten Start zieht.

## Umgebung

- **Demo App:** `apps/demo` (relativ zum Repo-Root)
- **Flavors:** `fdroid` (Default), `playstore`

## Ablauf

### Schritt 1: Repo-Root und SDK finden

```bash
# Repo-Root = git toplevel
REPO_ROOT=$(git rev-parse --show-toplevel)

# Android SDK finden (in dieser Reihenfolge prüfen)
if [ -n "$ANDROID_HOME" ]; then
  SDK="$ANDROID_HOME"
elif [ -f "$REPO_ROOT/apps/demo/android/local.properties" ]; then
  SDK=$(grep sdk.dir "$REPO_ROOT/apps/demo/android/local.properties" | cut -d= -f2)
elif [ -d "$HOME/Android/Sdk" ]; then
  SDK="$HOME/Android/Sdk"
else
  echo "Android SDK nicht gefunden"
fi
export ANDROID_HOME="$SDK"
```

### Schritt 2: Gerät prüfen

```bash
adb devices
```

Wenn kein Gerät angeschlossen:

- Sage dem User: "Kein Android-Gerät gefunden. Bitte USB-Debugging aktivieren und Gerät anschließen."
- Stoppe hier.

### Schritt 3: Flavor und OTA-Channel bestimmen

Interpretiere $ARGUMENTS:

- `fdroid`, `f-droid`, `foss` → Flavor `fdroid`, OTA-Channel `android-foss`
- `playstore`, `play`, `google` → Flavor `playstore`, OTA-Channel `android`
- Ohne Argument → Default: Flavor `fdroid`, OTA-Channel `android-foss`

**Wichtig:** Der Gradle-Flavor bestimmt native Features (z.B. Google Push). Der OTA-Channel bestimmt welchen Update-Server die App nach Web-Updates fragt. Beides ist unabhängig.

### Schritt 4: Web-Assets bauen + Sync + APK

```bash
cd "$REPO_ROOT/apps/demo"
VITE_UPDATE_SERVER_URL=https://web-of-trust.de VITE_UPDATE_CHANNEL=<OTA_CHANNEL> pnpm build:mobile
cd android
./gradlew assemble<Flavor>Debug    # z.B. assembleFdroidDebug
```

Ersetze `<OTA_CHANNEL>` mit `android-foss` (fdroid) oder `android` (playstore).
`build:mobile` setzt bereits `VITE_BASE_PATH=/`, baut und synct.

### Schritt 5: Installieren und starten

```bash
adb -s <DEVICE_ID> install -r app/build/outputs/apk/<flavor>/debug/app-<flavor>-debug.apk
adb -s <DEVICE_ID> shell am start -n org.utopialab.weboftrust/.MainActivity
```

Falls `INSTALL_FAILED_UPDATE_INCOMPATIBLE` (andere Signatur): Frage den User ob die alte App deinstalliert werden darf (lokale Daten gehen verloren). Wenn ja:

```bash
adb -s <DEVICE_ID> uninstall org.utopialab.weboftrust
```

### Schritt 6: Bestätigung

Sage dem User:

- Welcher Flavor gebaut wurde
- Auf welches Gerät deployed wurde
- Ob der Build erfolgreich war

## Häufige Probleme

- **"No connected devices"**: USB-Debugging in Entwickleroptionen aktivieren
- **"SDK not found"**: `local.properties` mit `sdk.dir=/pfad/zum/sdk` anlegen
- **Weißer Bildschirm**: `VITE_BASE_PATH` muss `/` sein, NICHT `/demo/`
- **Gradle Fehler**: `cd android && ./gradlew clean` und nochmal versuchen
- **Signatur-Konflikt**: Alte App deinstallieren (User fragen!)
