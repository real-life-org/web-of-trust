---
description: Baut die WoT Demo App und deployt sie auf ein verbundenes Android-Gerät. Nutze diesen Skill wenn jemand die App testen, bauen oder auf ein Handy deployen will.
allowed-tools: [Bash, Read, Glob]
---

# Android Deploy

Baut die WoT Demo App und deployt auf ein Android-Gerät.

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

### Schritt 3: Flavor bestimmen

Interpretiere $ARGUMENTS:

- `fdroid`, `f-droid`, `foss` → Flavor `fdroid`
- `playstore`, `play`, `google` → Flavor `playstore`
- Ohne Argument → Default: `fdroid`

### Schritt 4: Web-Assets bauen + Sync + APK

```bash
cd "$REPO_ROOT"
VITE_BASE_PATH=/ pnpm --filter demo exec vite build
cd apps/demo
npx cap sync android
cd android
./gradlew assemble<Flavor>Debug    # z.B. assembleFdroidDebug
```

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
