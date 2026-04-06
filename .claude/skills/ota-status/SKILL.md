---
description: Zeigt den OTA-Update-Status — welches Bundle läuft auf dem Gerät, was ist auf dem Server, läuft die Pipeline noch? Nutze diesen Skill wenn jemand wissen will ob ein OTA-Update angekommen ist.
allowed-tools: [Bash, Read]
---

# OTA Status

Zeigt den aktuellen Stand der OTA-Updates für die WoT Demo App.

## Ablauf

### Schritt 1: Alle Infos parallel sammeln

Führe diese drei Checks parallel aus:

**a) Bundle auf dem Gerät (wenn angeschlossen):**

```bash
adb devices 2>/dev/null | grep -v "List" | grep device
```

Wenn Gerät da:

```bash
adb logcat -d | grep "getCurrentBundle" | tail -3
```

Alternativ — App-Logs der letzten Minute:

```bash
adb logcat -d -t 60 | grep -i "bundleId\|LiveUpdate\|downloadBundle\|update.*fail"
```

**b) Neuestes Bundle auf dem Server:**

```bash
curl -s https://web-of-trust.de/updates/android-foss/latest.json 2>/dev/null
curl -s https://web-of-trust.de/updates/android/latest.json 2>/dev/null
curl -s https://web-of-trust.de/updates/ios/latest.json 2>/dev/null
```

**c) Pipeline-Status auf GitHub:**

```bash
cd "$(git rev-parse --show-toplevel)"
gh run list --workflow=deploy.yml --limit=3
```

### Schritt 2: Zusammenfassung

Zeige eine übersichtliche Tabelle:

```
| Kanal        | Server-Bundle | Gerät-Bundle | Status |
|--------------|---------------|--------------|--------|
| android-foss | abc1234       | abc1234      | ✅ Aktuell |
| android      | abc1234       | —            | — Kein Gerät |
| ios          | abc1234       | —            | — Kein Gerät |
```

Und Pipeline-Status:

```
Letzte Pipeline: ✅ erfolgreich (vor 3 Min) — Commit: "fix: bottom padding"
```

Wenn Server-Bundle ≠ Gerät-Bundle:

- "Das Gerät hat ein älteres Bundle. App schließen und neu öffnen um das Update zu laden."

Wenn Pipeline noch läuft:

- "Pipeline läuft noch — Bundle wird in ~1-2 Min verfügbar sein."
